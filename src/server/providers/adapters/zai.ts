/**
 * Z.AI — model ids are the enums in docs.z.ai/openapi.json.
 * Token prices come from the pricing page when a row lowercases onto one
 * of those ids. USD per 1M tokens. A row that does not match an enum is ignored.
 *
 * The same OpenAPI document gives each id its route (the path whose request
 * body lists it) and, for chat ids, the output cap (`max_tokens`
 * description) and input modalities (user message content parts). Context
 * windows come from the overview page's model tables, reasoning efforts
 * from the Deep Thinking page. A model with no effort list is a toggle:
 * the request's `thinking.type` switch, whose description names the models
 * that cannot turn it off. Each parser throws on a shape it does not know
 * rather than guess.
 *
 * The chat body is a `oneOf` of a text and a vision request, split by
 * `model` enum with no discriminator, and several properties say in prose
 * which models they are "supported by". So capability flags are listed
 * here per model (`exactCapabilities`), not walked from the merged body.
 */
import { compileTokenCard } from '@modelschemas/rate-card'

import type { Activity } from '#/db/schema.ts'

import { walkRequestSchema } from '../fact-sources.ts'
import { tokenCount } from '../model-facts.ts'
import { fetchOpenApi, fetchText, sha256Text } from '../types.ts'
import type {
  FactSource,
  ListModelsResult,
  ModelFactSources,
  ModelInfo,
  ModelReasoning,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

export const ZAI_OPENAPI_URL = 'https://docs.z.ai/openapi.json'
export const ZAI_PRICING_URL = 'https://docs.z.ai/guides/overview/pricing.md'
export const ZAI_OVERVIEW_URL = 'https://docs.z.ai/guides/overview/overview.md'
export const ZAI_THINKING_URL =
  'https://docs.z.ai/guides/capabilities/thinking.md'

const FETCH_TIMEOUT_MS = 30_000
const MODEL_ID = /^(?:glm|cog)[a-z0-9._-]*$/

/**
 * How one docs site words the prose these parsers read. Z.AI writes
 * English. Zhipu's China docs state the same facts in the same shapes in
 * Chinese (`zhipuai-coding-plan.ts`).
 */
export interface GlmWording {
  /** Provider id that prefixes a parser's error. */
  label: string
  /** Header cells of the overview table's model and context columns. */
  modelColumn: string
  contextColumn: string
  /** Sits between a `max_tokens` clause's models and its cap. */
  supports: RegExp
  /** The cap, at the start of what follows `supports`. Group 1 is the size. */
  cap: RegExp
  /** Ends a list of models that are series, not single ids. */
  series: RegExp
  /** List filler between model names, as a pattern source. */
  filler: string
  /** A description's "only these models" clause. Group 1 is the model list. */
  supportedBy: RegExp
  /** Says the clause names a version floor, not a list. */
  floor: RegExp
  /** Filler in a version-floor clause, as a pattern source. */
  floorFiller: string
}

export const ZAI_WORDING: GlmWording = {
  label: 'zai',
  modelColumn: 'Model',
  contextColumn: 'Context',
  supports: /\bsupports\b/,
  cap: /^\s+(?:a maximum output length of\s+)?(\d+(?:\.\d+)?[KM])\b(?:\s+maximum output\b)?/,
  series: /\bseries\s*$/,
  filler: '\\b(?:the|and|series)\\b',
  supportedBy: /supported by (.+?)(?:\.\s|\.$|$)/is,
  floor: /\b(?:higher|above)\b/i,
  floorFiller: '\\b(?:series|and|higher|above|models?|versions?)\\b',
}

/** One fetched source document. */
export interface ZaiDoc {
  url: string
  text: string
  hash: string
}

interface TokenPrice {
  input: number
  output: number
  cache: number | null
}

/** What the docs say about some models, named one by one or as a series. */
export interface ModelNames {
  names: Array<string>
  /** True when a name also covers its variants (`glm-4.7` → `glm-4.7-flash`). */
  series: boolean
}

interface OutputCap extends ModelNames {
  tokens: number
}

interface ReasoningRow extends ModelNames {
  reasoning: ModelReasoning
}

interface SpecFacts {
  activity: Activity
  schemaEndpointId: string
  maxOutput: number | null
  modalities: { input: Array<string>; output: Array<string> } | null
  /** The `reasoning_effort` enum of the request variant that lists the id. */
  efforts: Array<string>
  /** The variant's `thinking.type` schema, unread; undefined when it has none. */
  thinkingType: unknown
  /** Chat only: flag → where the variant's own request states it. */
  capabilities: Record<string, FactSource> | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function list(value: unknown): Array<unknown> {
  return Array.isArray(value) ? value : []
}

function money(cell: string): number | null {
  const match = cell.match(/\$([0-9]+(?:\.[0-9]+)?)/)
  if (!match?.[1]) return null
  const value = Number(match[1])
  return Number.isFinite(value) && value > 0 ? value : null
}

const MODEL_NAME = /(?:auto)?glm-[a-z0-9.-]*[a-z0-9]/gi

export function modelNames(text: string): Array<string> {
  return (text.match(MODEL_NAME) ?? []).map((name) => name.toLowerCase())
}

/**
 * The row that names this id. The longest name wins, and a series name must
 * end where the version does, so `glm-5.3-flash` is `glm-5.3`, never `glm-5`.
 */
export function namedBy<T extends ModelNames>(
  rawId: string,
  rows: Array<T>,
): T | null {
  let best: T | null = null
  let bestLength = 0
  for (const row of rows) {
    for (const name of row.names) {
      const hit =
        rawId === name ||
        (row.series &&
          rawId.startsWith(name) &&
          !/[\d.]/.test(rawId.charAt(name.length)))
      if (hit && name.length > bestLength) {
        best = row
        bestLength = name.length
      }
    }
  }
  return best
}

export function zaiModelIds(spec: unknown): Array<string> {
  const ids = new Set<string>()
  const walk = (node: unknown) => {
    if (!isRecord(node)) return
    if (Array.isArray(node.enum)) {
      for (const value of node.enum) {
        if (typeof value === 'string' && MODEL_ID.test(value)) ids.add(value)
      }
    }
    for (const value of Object.values(node)) walk(value)
  }
  walk(spec)
  if (ids.size === 0) throw new Error('zai: OpenAPI has no model enums')
  return [...ids].sort()
}

/** Per-1M-token tables. The key is the model cell lowercased. */
export function parseZaiTokenPrices(markdown: string): Map<string, TokenPrice> {
  if (!/per 1M tokens/i.test(markdown)) {
    throw new Error('zai: pricing page has no per-1M-token table')
  }
  const prices = new Map<string, TokenPrice>()
  let inTokenTable = false
  for (const line of markdown.split('\n')) {
    if (/per 1M tokens/i.test(line)) {
      inTokenTable = true
      continue
    }
    if (/^#{1,3} /.test(line)) {
      inTokenTable = false
      continue
    }
    if (!inTokenTable || !line.startsWith('|')) continue
    if (/^\|\s*:?-+/.test(line)) continue
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim())
    const name = cells[0]
    if (!name || name === 'Model' || cells.length < 5) continue
    const input = money(cells[1] ?? '')
    const output = money(cells[4] ?? '')
    if (input === null || output === null) continue
    prices.set(name.toLowerCase(), {
      input,
      output,
      cache: money(cells[2] ?? ''),
    })
  }
  return prices
}

/**
 * The `Context` column of the overview page's model tables, keyed by the
 * model cell lowercased. `/` means the model has no context window. With
 * `only`, the other rows are not read.
 */
export function parseZaiContextWindows(
  markdown: string,
  wording: GlmWording = ZAI_WORDING,
  only?: (name: string) => boolean,
): Map<string, number> {
  const windows = new Map<string, number>()
  let header: Array<string> = []
  let column = -1
  for (const raw of markdown.split('\n')) {
    // The "other models" tables sit indented inside an accordion.
    const line = raw.trim()
    if (!line.startsWith('|')) {
      column = -1
      continue
    }
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim())
    if (cells.every((cell) => /^:?-+:?$/.test(cell))) {
      column =
        header[0] === wording.modelColumn
          ? header.indexOf(wording.contextColumn)
          : -1
      continue
    }
    header = cells
    // The China docs link each model name to its page.
    const name = cells[0]?.replace(/^\[([^\]]+)\]\(.*\)$/, '$1')
    const cell = cells[column]
    if (column < 0 || !name || cell === '/') continue
    if (only && !only(name.toLowerCase())) continue
    const tokens = /^\d+(?:\.\d+)?[KM]$/.test(cell ?? '')
      ? tokenCount(cell)
      : null
    if (tokens === null) {
      throw new Error(
        `${wording.label}: unreadable context window for ${name}: ${String(cell)}`,
      )
    }
    windows.set(name.toLowerCase(), tokens)
  }
  if (windows.size === 0) {
    throw new Error(`${wording.label}: overview page has no context windows`)
  }
  return windows
}

/** True when `text`, its model names aside, is only list filler. */
function onlyNames(text: string, filler: string): boolean {
  const rest = text.replace(MODEL_NAME, ' ')
  return new RegExp(`^(?:[\\s,.\`]|${filler})*$`, 'i').test(rest)
}

/**
 * A `max_tokens` description: "<models> [series] supports <N>K", repeated.
 * Every model name must sit in a clause of exactly that shape. A clause
 * with another verb would otherwise be read as part of the next clause's
 * subject and take its cap, so anything left over throws.
 */
export function parseZaiOutputCaps(
  description: string,
  wording: GlmWording = ZAI_WORDING,
): Array<OutputCap> {
  const [first = '', ...rest] = description.split(wording.supports)
  if (rest.length === 0) {
    throw new Error(
      `${wording.label}: max_tokens description states no output cap`,
    )
  }
  const caps: Array<OutputCap> = []
  // The opening sentence runs up to the first model name.
  let subject = first.slice(Math.max(first.search(MODEL_NAME), 0))
  for (const part of rest) {
    const cap = part.match(wording.cap)
    const names = modelNames(subject)
    const tokens = tokenCount(cap?.[1])
    if (
      !cap ||
      tokens === null ||
      names.length === 0 ||
      !onlyNames(subject, wording.filler)
    ) {
      throw new Error(
        `${wording.label}: unreadable output cap: ${subject.trim()} supports${part}`,
      )
    }
    caps.push({ names, series: wording.series.test(subject), tokens })
    subject = part.slice(cap[0].length)
  }
  if (modelNames(subject).length > 0) {
    throw new Error(
      `${wording.label}: model with no output cap: ${subject.trim()}`,
    )
  }
  return caps
}

/**
 * Does a property description's "supported by <models>" clause cover this
 * id? Null when the description has no such clause. A clause that is not a
 * plain model list, or a "<model> and higher" floor, covers nothing.
 */
export function zaiSupportedBy(
  description: string,
  rawId: string,
  wording: GlmWording = ZAI_WORDING,
): boolean | null {
  const clause = description.match(wording.supportedBy)?.[1]
  if (clause === undefined) return null
  const names = modelNames(clause)
  if (names.length === 0) return false
  if (wording.floor.test(clause)) {
    const version = (id: string) => id.match(/^glm-(\d+(?:\.\d+)?)/)?.[1]
    const floor = version(names[0] ?? '')
    const own = version(rawId)
    return (
      names.length === 1 &&
      onlyNames(clause, wording.floorFiller) &&
      floor !== undefined &&
      own !== undefined &&
      Number(own) >= Number(floor)
    )
  }
  return (
    onlyNames(clause, wording.filler) &&
    namedBy(rawId, [{ names, series: true }]) !== null
  )
}

/**
 * The "In the API request" bullets under `reasoning_effort` on the Deep
 * Thinking page: "For <models>, only | the supported options are <values>."
 * The page and the spec both speak of these names as series. `mandatory`
 * here is inferred from the list (no `none` reads as true), which predates
 * the stated-only rule on `ModelReasoning`.
 */
export function parseZaiReasoning(markdown: string): Array<ReasoningRow> {
  const block = markdown.match(
    /In the API request:\n([\s\S]*?)\n[^\n]*In the Coding Plan request:/,
  )?.[1]
  if (block === undefined) {
    throw new Error('zai: Deep Thinking page has no API reasoning_effort list')
  }
  const rows: Array<ReasoningRow> = []
  for (const line of block.split('\n')) {
    if (line.trim() === '') continue
    const match = line.match(
      /^[\s*]*For (.+?), (?:only|the supported options are) ([^.]+)\./,
    )
    const names = modelNames(match?.[1] ?? '')
    const efforts = [...(match?.[2] ?? '').matchAll(/`([a-z]+)`/g)].flatMap(
      (effort) => (effort[1] ? [effort[1]] : []),
    )
    if (names.length === 0 || efforts.length === 0) {
      throw new Error(`zai: unreadable reasoning_effort line: ${line.trim()}`)
    }
    rows.push({
      names,
      series: true,
      reasoning: {
        mode: 'effort',
        mandatory: !efforts.includes('none'),
        efforts,
      },
    })
  }
  if (rows.length === 0) {
    throw new Error('zai: Deep Thinking page lists no reasoning_effort values')
  }
  return rows
}

/**
 * The `thinking.type` description: "Whether to enable the chain of
 * thought(<models> series can only be enabled, …; for other models, when
 * enabled, …), default: enabled". Group 1 is the models that reject
 * `disabled`; every other model the switch covers may send either value.
 */
const THINKING_TYPE =
  /^Whether to enable the chain of thought\((.+?) series can only be enabled\b[^;]*; for other models, when enabled, [^)]*\), default: enabled$/

/**
 * The models whose `thinking.type` cannot be `disabled`, from the switch's
 * own schema. Throws unless the enum is exactly `enabled | disabled` and
 * the description has the shape above: a third value or a reworded
 * sentence is a switch this cannot read.
 */
export function parseZaiThinkingSwitch(type: unknown): ModelNames {
  const node = isRecord(type) ? type : {}
  const values = list(node.enum).map(String).sort().join()
  const locked =
    typeof node.description === 'string'
      ? node.description.match(THINKING_TYPE)?.[1]
      : undefined
  const names = modelNames(locked ?? '')
  if (
    values !== 'disabled,enabled' ||
    locked === undefined ||
    names.length === 0 ||
    !onlyNames(locked, ZAI_WORDING.filler)
  ) {
    throw new Error('zai: unreadable thinking.type switch')
  }
  return { names, series: true }
}

/** Follow `$ref`s, then walk `keys`; undefined when the path is not there. */
function at(spec: unknown, node: unknown, ...keys: Array<string>): unknown {
  const components = isRecord(spec) ? spec.components : undefined
  const schemas = isRecord(components) ? components.schemas : undefined
  const deref = (value: unknown): unknown => {
    let current = value
    for (
      let depth = 0;
      depth < 8 && isRecord(current) && typeof current.$ref === 'string';
      depth++
    ) {
      const name = current.$ref.replace('#/components/schemas/', '')
      current = isRecord(schemas) ? schemas[name] : undefined
    }
    return current
  }
  let current = deref(node)
  for (const key of keys) {
    if (!isRecord(current)) return undefined
    current = deref(current[key])
  }
  return current
}

const CONTENT_PART: Record<string, string> = {
  text: 'text',
  image_url: 'image',
  video_url: 'video',
  file: 'file',
}

/** What a user message may carry: a string, or the listed content parts. */
function userInputs(
  spec: unknown,
  messages: unknown,
  label: string,
): Array<string> {
  const user = list(at(spec, messages, 'items', 'oneOf')).find((message) =>
    list(at(spec, message, 'properties', 'role', 'enum')).includes('user'),
  )
  const inputs = new Set<string>()
  // The China document writes a text-only content as a bare string schema.
  const content = at(spec, user, 'properties', 'content')
  const shapes = at(spec, content, 'oneOf')
  const bare = content === undefined ? [] : [content]
  for (const shape of Array.isArray(shapes) ? shapes : bare) {
    if (at(spec, shape, 'type') === 'string') {
      inputs.add('text')
      continue
    }
    const parts = list(at(spec, shape, 'items', 'oneOf'))
    if (parts.length === 0) {
      throw new Error(`${label}: user message content lists no parts`)
    }
    for (const part of parts) {
      const type = list(at(spec, part, 'properties', 'type', 'enum'))[0]
      const modality = typeof type === 'string' ? CONTENT_PART[type] : undefined
      if (!modality) {
        throw new Error(
          `${label}: unknown message content part: ${String(type)}`,
        )
      }
      inputs.add(modality)
    }
  }
  if (inputs.size === 0) {
    throw new Error(`${label}: chat request has no user message content`)
  }
  return ['text', 'image', 'video', 'file'].filter((kind) => inputs.has(kind))
}

/**
 * The flags of one request variant that hold for one of its models: the
 * shared walk's flags for the variant's own properties, less any whose
 * description says "supported by" other models. `tool_choice` goes with
 * `tools`.
 */
function variantCapabilities(
  spec: unknown,
  props: Record<string, unknown>,
  rawId: string,
  meta: Parameters<typeof walkRequestSchema>[1],
  wording: GlmWording,
): Record<string, FactSource> {
  const walked = walkRequestSchema({ properties: props }, meta)
  const kept = Object.entries(walked?.sources.capabilities ?? {}).filter(
    ([, source]) => {
      const property = source.path?.split('/')[2] ?? ''
      const description = at(spec, props[property], 'description')
      return (
        typeof description !== 'string' ||
        zaiSupportedBy(description, rawId, wording) !== false
      )
    },
  )
  const flags = Object.fromEntries(kept)
  if (!('tools' in flags)) delete flags.tool_choice
  return flags
}

/**
 * Route and request-body facts for each id a generation path's request
 * lists under `model`. The first path that lists an id binds it. With
 * `only`, a request variant that lists none of those ids is not read.
 */
export function zaiSpecFacts(
  spec: unknown,
  source: { url: string; hash: string } = { url: ZAI_OPENAPI_URL, hash: '' },
  {
    wording = ZAI_WORDING,
    classify = classifyZaiPath,
    only,
  }: {
    wording?: GlmWording
    classify?: (path: string) => Activity | null
    only?: (id: string) => boolean
  } = {},
): Map<string, SpecFacts> {
  const facts = new Map<string, SpecFacts>()
  const paths = at(spec, spec, 'paths')
  for (const [path, item] of Object.entries(isRecord(paths) ? paths : {})) {
    const activity = classify(path)
    if (activity === null) continue
    const schemaEndpointId = path.replace(/^\//, '')
    const content = at(spec, item, 'post', 'requestBody', 'content')
    for (const media of Object.values(isRecord(content) ? content : {})) {
      const body = at(spec, media, 'schema')
      const variants = at(spec, body, 'oneOf')
      for (const variant of Array.isArray(variants) ? variants : [body]) {
        const props: Record<string, unknown> = {}
        for (const part of [variant, ...list(at(spec, variant, 'allOf'))]) {
          const own = at(spec, part, 'properties')
          if (isRecord(own)) Object.assign(props, own)
        }
        const ids = list(at(spec, props.model, 'enum')).filter(
          (id): id is string =>
            typeof id === 'string' && MODEL_ID.test(id) && (only?.(id) ?? true),
        )
        if (ids.length === 0) continue
        const chat =
          activity === 'chat'
            ? {
                caps: parseZaiOutputCaps(
                  String(at(spec, props.max_tokens, 'description') ?? ''),
                  wording,
                ),
                input: userInputs(spec, props.messages, wording.label),
              }
            : null
        // "128K" is a label; `maximum` is the bound, when it is that tier's.
        // A label above the bound contradicts it: neither is stored.
        const maximum = at(spec, props.max_tokens, 'maximum')
        const exact = (tokens: number | undefined) => {
          if (tokens === undefined) return null
          if (typeof maximum !== 'number') return tokens
          const binary = (tokens / 1000) * 1024
          if (binary > maximum) return null
          return binary === maximum ? maximum : tokens
        }
        const efforts = list(at(spec, props.reasoning_effort, 'enum')).filter(
          (effort): effort is string => typeof effort === 'string',
        )
        for (const id of ids) {
          if (facts.has(id)) continue
          facts.set(id, {
            activity,
            schemaEndpointId,
            maxOutput: chat ? exact(namedBy(id, chat.caps)?.tokens) : null,
            modalities: chat ? { input: chat.input, output: ['text'] } : null,
            efforts,
            thinkingType: at(spec, props.thinking, 'properties', 'type'),
            capabilities: chat
              ? variantCapabilities(
                  spec,
                  props,
                  id,
                  {
                    derivation: 'upstream-spec',
                    endpointId: schemaEndpointId,
                    sourceUrl: source.url,
                    sourceHash: source.hash,
                  },
                  wording,
                )
              : null,
          })
        }
      }
    }
  }
  if (![...facts.values()].some((fact) => fact.activity === 'chat')) {
    throw new Error(`${wording.label}: OpenAPI chat request lists no model ids`)
  }
  return facts
}

export function parseZaiModels(
  spec: ZaiDoc,
  pricing: ZaiDoc,
  overview: ZaiDoc,
  thinking: ZaiDoc,
  extractedAt: string,
): Array<ModelInfo> {
  const document: unknown = JSON.parse(spec.text)
  const prices = parseZaiTokenPrices(pricing.text)
  const windows = parseZaiContextWindows(overview.text)
  const reasonings = parseZaiReasoning(thinking.text)
  const facts = zaiSpecFacts(document, spec)
  const from = (
    doc: ZaiDoc,
    derivation: FactSource['derivation'],
    path: string,
  ): FactSource => ({
    derivation,
    sourceUrl: doc.url,
    sourceHash: doc.hash,
    path,
  })
  return zaiModelIds(document).map((rawId) => {
    const price = prices.get(rawId)
    const rates = price
      ? {
          input_tokens: price.input / 1_000_000,
          output_tokens: price.output / 1_000_000,
          ...(price.cache !== null
            ? { cache_read_tokens: price.cache / 1_000_000 }
            : {}),
        }
      : null
    const card = rates
      ? compileTokenCard(rates, [], {
          url: pricing.url,
          hash: pricing.hash,
          extractedAt,
        })
      : null
    const fact = facts.get(rawId)
    const contextWindow = windows.get(rawId) ?? null
    const effort = namedBy(rawId, reasonings)?.reasoning ?? null
    // The thinking page names series. Cite the request variant instead when
    // its own enum is the same list, as it is for `glm-5.3-flashx`.
    const specEfforts =
      effort?.efforts !== undefined &&
      [...effort.efforts].sort().join() ===
        [...(fact?.efforts ?? [])].sort().join()
    // No effort list for the model means no `reasoning_effort` flag either.
    const capabilities = fact?.capabilities
      ? Object.fromEntries(
          Object.entries(fact.capabilities).filter(
            ([flag]) => flag !== 'reasoning_effort' || effort !== null,
          ),
        )
      : null
    // No effort list, and `thinking` covers the model: the switch is all
    // there is. The request variant is shared, so its `disabled` states
    // nothing; the description says which models may send it.
    const toggle: ModelReasoning | null =
      effort === null && capabilities && 'reasoning' in capabilities
        ? {
            mode: 'toggle',
            mandatory:
              namedBy(rawId, [parseZaiThinkingSwitch(fact?.thinkingType)]) !==
              null,
          }
        : null
    const reasoning = effort ?? toggle
    const factSources: ModelFactSources = {
      ...(card ? { pricing: from(pricing, 'docs-derived', 'Pricing') } : {}),
      ...(contextWindow !== null
        ? { contextWindow: from(overview, 'docs-derived', 'Context') }
        : {}),
      ...(effort
        ? {
            reasoning: specEfforts
              ? from(spec, 'upstream-spec', 'reasoning_effort')
              : from(thinking, 'docs-derived', 'reasoning_effort'),
          }
        : toggle
          ? { reasoning: from(spec, 'upstream-spec', 'thinking.type') }
          : {}),
      ...(capabilities && Object.keys(capabilities).length > 0
        ? { capabilities }
        : {}),
      ...(fact?.maxOutput != null
        ? { maxOutput: from(spec, 'upstream-spec', 'max_tokens') }
        : {}),
      ...(fact?.modalities
        ? { modalities: from(spec, 'upstream-spec', 'messages') }
        : {}),
    }
    return {
      rawId,
      pricing: card,
      ...(fact
        ? {
            activity: fact.activity,
            schemaEndpointId: fact.schemaEndpointId,
            maxOutput: fact.maxOutput,
            modalities: fact.modalities,
          }
        : {}),
      ...(capabilities
        ? { capabilities: Object.keys(capabilities), exactCapabilities: true }
        : {}),
      ...(contextWindow !== null ? { contextWindow } : {}),
      ...(reasoning ? { reasoning } : {}),
      ...(Object.keys(factSources).length > 0 ? { factSources } : {}),
    }
  })
}

export async function fetchZaiDoc(url: string, label = 'zai'): Promise<ZaiDoc> {
  const text = await fetchText(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  // A 200 that is a web page is an error page, not the document.
  if (/^\s*<(?:!doctype|html)/i.test(text)) {
    throw new Error(`${label}: ${url} returned HTML, not the document`)
  }
  return { url, text, hash: await sha256Text(text) }
}

async function listModels(_env: ProviderSecrets): Promise<ListModelsResult> {
  const [spec, pricing, overview, thinking] = await Promise.all([
    fetchZaiDoc(ZAI_OPENAPI_URL),
    fetchZaiDoc(ZAI_PRICING_URL),
    fetchZaiDoc(ZAI_OVERVIEW_URL),
    fetchZaiDoc(ZAI_THINKING_URL),
  ])
  return {
    models: parseZaiModels(
      spec,
      pricing,
      overview,
      thinking,
      new Date().toISOString(),
    ),
  }
}

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const { spec, hash } = await fetchOpenApi(ZAI_OPENAPI_URL)
  return {
    specs: [spec],
    sources: [{ url: ZAI_OPENAPI_URL, hash }],
    outputStrategy: 'post-200',
    specRevision: hash,
  }
}

export function classifyZaiPath(path: string): Activity | null {
  if (path.includes('/chat/completions')) return 'chat'
  if (path.includes('/images/')) return 'image'
  if (path.includes('/videos/')) return 'video'
  if (path.includes('/audio/')) return 'audio'
  return null
}

export const provider: ProviderConfig = {
  id: 'zai',
  displayName: 'Z.AI',
  specSourceUrl: ZAI_OPENAPI_URL,
  modelsEndpoint: ZAI_OPENAPI_URL,
  defaultDerivation: 'upstream-spec',
  fetchSpec,
  listModels,
  classify: (path) => classifyZaiPath(path),
}
