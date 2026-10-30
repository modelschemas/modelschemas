/**
 * Reasoning objects for chat rows whose capabilities already say `reasoning`
 * (issue #110). Mode and effort names come only from a native listing or
 * docs page. A model the source does not configure stays null; `path:
 * 'silent'` records that the page was read and did not state a mode.
 */
import { ingestFailedEvent, noteIngest } from '../ingest/ingest-signals.ts'
import { emptySources } from './fact-sources.ts'
import {
  assertParsed,
  cachedDocs,
  markdownTableRows,
  tryDocs,
  unavailable,
} from './model-facts.ts'
import type { DocsRun } from './model-facts.ts'
import { groqModelPageUrl } from './groq-pricing.ts'
import { fetchByteplusDoc } from './byteplus-docs.ts'
import { pricingContent, tableRows } from './byteplus-pricing.ts'
import type { ByteplusDoc } from './byteplus-pricing.ts'
import { fetchText, reasoningViolation, sha256Text } from './types.ts'
import type { ModelFactSources, ModelInfo, ModelReasoning } from './types.ts'

export const MISTRAL_REASONING_URL =
  'https://docs.mistral.ai/studio/conversations/reasoning.md'
export const GROQ_REASONING_URL = 'https://console.groq.com/docs/reasoning.md'
export const COHERE_REASONING_URL = 'https://docs.cohere.com/docs/reasoning.md'
export const BYTEPLUS_REASONING_URL =
  'https://docs.byteplus.com/en/docs/ModelArk/1449737'

/** The thinking page names no mode for this id. */
export const REASONING_SOURCE_SILENT = 'silent'

/**
 * The write gate for `reasoning`. A listed object that breaks the shape is
 * not stored: the row keeps the value and source it had (null on a new row),
 * the poll goes on, and an `ingest_failed` event names the model and reason.
 */
export function keepValidReasoning(
  providerId: string,
  info: ModelInfo,
  prior?: { reasoning: unknown; factSources: unknown },
): ModelInfo {
  if (info.reasoning == null) return info
  const reason = reasoningViolation(info.reasoning)
  if (reason === null) return info
  noteIngest(
    ingestFailedEvent(
      'models-poll',
      providerId,
      `${info.rawId}: reasoning not stored: ${reason}`,
    ),
  )
  const { reasoning: _refused, ...sources } = info.factSources ?? {}
  const priorSource = (prior?.factSources as ModelFactSources | null)?.reasoning
  const factSources = priorSource
    ? { ...sources, reasoning: priorSource }
    : sources
  return {
    ...info,
    reasoning: (prior?.reasoning ?? null) as ModelReasoning | null,
    factSources: emptySources(factSources) ? undefined : factSources,
  }
}

export function listsReasoning(capabilities: unknown): boolean {
  return Array.isArray(capabilities) && capabilities.includes('reasoning')
}

function docsReasoningSource(
  sourceUrl: string,
  sourceHash: string,
  path: string,
): ModelFactSources {
  return {
    reasoning: {
      derivation: 'docs-derived',
      sourceUrl,
      sourceHash,
      path,
    },
  }
}

/**
 * Attach a parsed reasoning object, or a silent note when the row already
 * has the reasoning capability and this source does not configure it.
 */
export function reasoningFactsFor(
  rawId: string,
  byId: Record<string, ModelReasoning>,
  source: { url: string; hash: string },
  capability: boolean,
): Partial<ModelInfo> {
  const reasoning = byId[rawId]
  if (reasoning) {
    return {
      reasoning,
      factSources: docsReasoningSource(source.url, source.hash, 'reasoning'),
    }
  }
  if (!capability) return {}
  return {
    factSources: docsReasoningSource(
      source.url,
      source.hash,
      REASONING_SOURCE_SILENT,
    ),
  }
}

/** Merge docs patches without letting one factSources bag replace another. */
export function overlayModelFacts(
  model: ModelInfo,
  ...patches: Array<Partial<ModelInfo>>
): ModelInfo {
  let next: ModelInfo = { ...model }
  const factSources: ModelFactSources = { ...model.factSources }
  for (const patch of patches) {
    const { factSources: more, absent, ...rest } = patch
    next = { ...next, ...rest }
    // Each patch may mark its own facts absent; one must not erase another's.
    if (absent) next.absent = { ...next.absent, ...absent }
    if (more) Object.assign(factSources, more)
  }
  if (emptySources(factSources)) {
    const { factSources: _drop, ...bare } = next
    return bare
  }
  return { ...next, factSources }
}

/**
 * OpenRouter `GET /api/v1/models` reasoning object. `supported_efforts`
 * names the effort mode. `null` accepts gateway effort names supplied from
 * normative host docs; mandatory rows reject the documented disable value.
 * Without gateway docs, null keeps its effort names unknown. `supports_max_tokens` is a budget
 * only when the listing does not speak about efforts. No reasoning object,
 * or a mandatory flag that is not a boolean, stays null.
 */
export function openRouterReasoning(
  row: {
    reasoning?: {
      supported_efforts?: Array<string | null> | null
      mandatory?: unknown
      supports_max_tokens?: unknown
    } | null
  },
  gatewayEfforts?: ReadonlyArray<string>,
  gatewayToggle?: boolean,
): ModelReasoning | null {
  const reasoning = row.reasoning
  if (!reasoning || typeof reasoning !== 'object') return null
  for (const key of ['mandatory', 'supports_max_tokens'] as const) {
    const value = reasoning[key]
    if (value != null && typeof value !== 'boolean')
      throw new Error(`openrouter: malformed native ${key}`)
  }
  const declared = reasoning.supported_efforts
  if (
    declared != null &&
    (!Array.isArray(declared) ||
      declared.some(
        (value) =>
          value != null && (typeof value !== 'string' || !value.length),
      ))
  )
    throw new Error('openrouter: malformed native supported_efforts')
  if (typeof reasoning.mandatory !== 'boolean') return null
  const mandatory = reasoning.mandatory
  if (Array.isArray(reasoning.supported_efforts)) {
    const efforts = reasoning.supported_efforts.filter(
      (effort): effort is string =>
        typeof effort === 'string' && effort.length > 0,
    )
    if (efforts.length === 0) return null
    return { mode: 'effort', mandatory, efforts }
  }
  if (reasoning.supported_efforts === null) {
    return {
      mode: 'effort',
      mandatory,
      ...(gatewayEfforts
        ? {
            efforts: gatewayEfforts.filter(
              (value) => !mandatory || value !== 'none',
            ),
          }
        : {}),
    }
  }
  if (reasoning.supports_max_tokens === true) {
    return { mode: 'budget', mandatory }
  }
  if (gatewayToggle === true && mandatory === false)
    return { mode: 'toggle', mandatory: false }
  return null
}

/**
 * Mistral's reasoning guide. Bullets that name `reasoning_effort` are effort
 * mode. Effort names are the `reasoning_effort = "…"` values, unless the
 * same bullet publishes its own list. Native "always on, no parameter"
 * prose names no mode and contributes nothing.
 */
export function parseMistralReasoning(
  markdown: string,
): Map<string, ModelReasoning> {
  const out = new Map<string, ModelReasoning>()
  const prose = markdown.replace(/```[\s\S]*?```/g, '')
  const preludeEnd = prose.search(/handling thinking chunks/i)
  const prelude = preludeEnd < 0 ? prose : prose.slice(0, preludeEnd)
  const bullet =
    /`([a-z0-9][a-z0-9.-]*)`:\s*Supports adjustable reasoning via the `reasoning_effort`/g
  // `reasoning_effort = "none"` omits the thinking chunk for Mistral models.
  // Example assignments are still not an allowlist. A model's own value list
  // below replaces this.
  const noneOmits =
    /reasoning_effort\s*=\s*"none"[\s\S]{0,240}thinking chunk (?:is )?omitted/i.test(
      prelude,
    )
  for (const match of prelude.matchAll(bullet)) {
    const id = match[1]
    if (!id) continue
    out.set(id, { mode: 'effort', mandatory: noneOmits ? false : null })
  }
  // The scoped model list is followed by normative parameter values. These
  // are not code examples; an explicit model-specific list overrides them.
  const valueSection = prelude.split(
    'The `reasoning_effort` parameter controls',
  )[1]
  const levels = [
    ...(valueSection?.matchAll(/^- `reasoning_effort\s*=\s*"([a-z]+)"`:/gm) ??
      []),
  ].flatMap((match) => (match[1] ? [match[1]] : []))
  if (levels.length) {
    for (const id of out.keys())
      out.set(id, {
        mode: 'effort',
        mandatory: noneOmits && levels.includes('none') ? false : null,
        efforts: levels,
      })
  }
  const ownList =
    /`([a-z0-9][a-z0-9.-]*)`:[^\n]{0,240}?Supported values are ([^\n.]+)/g
  for (const match of prelude.matchAll(ownList)) {
    const id = match[1]
    if (!id || !out.has(id)) continue
    const efforts = [...(match[2] ?? '').matchAll(/`([a-z]+)`/g)].flatMap(
      (found) => (found[1] ? [found[1]] : []),
    )
    if (efforts.length === 0) continue
    const ownNote = prelude
      .split(/\n\s*\n/)
      .find(
        (para) =>
          para.split('\n').some((line) => line.startsWith('`' + id + '` ')) &&
          /always|cannot/i.test(para),
      )
    const alwaysThinking =
      !!ownNote &&
      /(?:reasoning|thinking)\s+(?:is\s+)?(?:always on|cannot be disabled|cannot be turned off)|is always returned[^.\n]*\(thinking\s*\+\s*text\)/i.test(
        ownNote,
      )
    out.set(id, {
      mode: 'effort',
      mandatory: alwaysThinking
        ? true
        : noneOmits && efforts.includes('none')
          ? false
          : null,
      efforts,
    })
  }
  return out
}

interface NamedModel {
  id: string
  label: string
}

function headingBlocks(
  markdown: string,
): Array<{ title: string; body: string }> {
  return markdown.split(/\n(?=#{2,3} )/).flatMap((part) => {
    const match = part.match(/^#{2,3} (.+)$/m)
    const title = (match?.[1] ?? '')
      .replace(/^\s*\[([^\]]+)\]\([^)]*\)\s*/, '$1')
      .replace(/\s*\([^)]*\)\s*$/, '')
      .trim()
    if (!match || title.length === 0) return []
    return [{ title, body: part.slice(part.indexOf('\n') + 1) }]
  })
}

function linkLabel(cell: string): string {
  return cell
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\\/g, '')
    .trim()
}

/** Rows of the Groq reasoning guide's Supported Models table. */
function groqSupportedModels(markdown: string): Array<NamedModel> {
  return headingBlocks(markdown)
    .filter((block) => block.title === 'Supported Models')
    .flatMap((block) => markdownTableRows(block.body))
    .flatMap((row) => {
      const id = (row[0] ?? '').trim()
      if (!/^[A-Za-z0-9][A-Za-z0-9./_-]*$/.test(id) || id === 'Model ID') {
        return []
      }
      return [{ id, label: linkLabel(row[1] ?? '') }]
    })
}

/** Groq reasoning page: per-model `reasoning_effort` tables. Ids the page lists as reasoning models but never gives options stay absent. */
export function parseGroqReasoning(
  markdown: string,
): Map<string, ModelReasoning> {
  const models = groqSupportedModels(markdown)
  const effortsById = new Map<string, Array<string>>()
  const conflicts = new Set<string>()
  for (const block of headingBlocks(markdown)) {
    if (!block.title.startsWith('Options for Reasoning Effort')) continue
    const efforts: Array<string> = []
    for (const row of markdownTableRows(block.body)) {
      const name = (row[0] ?? '').replace(/[`\\]/g, '').trim()
      if (/^[a-z]+$/.test(name) && !efforts.includes(name)) efforts.push(name)
    }
    if (efforts.length === 0) continue
    const norm = (value: string) =>
      value.toLowerCase().replace(/[^a-z0-9]/g, '')
    const sectionNorm = norm(block.body)
    const linked = [...block.body.matchAll(/\[([^\]]+)\]/g)].map((match) =>
      norm(match[1] ?? ''),
    )
    for (const model of models) {
      const labelNorm = norm(model.label)
      const named =
        block.body.includes(model.id) ||
        (labelNorm.length > 0 && sectionNorm.includes(labelNorm)) ||
        linked.some((name) => name.length >= 6 && labelNorm.includes(name))
      if (!named) continue
      const prior = effortsById.get(model.id)
      if (prior && prior.join('\0') !== efforts.join('\0')) {
        conflicts.add(model.id)
        continue
      }
      effortsById.set(model.id, efforts)
    }
  }
  const out = new Map<string, ModelReasoning>()
  for (const [id, efforts] of effortsById) {
    if (conflicts.has(id)) continue
    out.set(id, {
      mode: 'effort',
      mandatory: !efforts.includes('none'),
      efforts,
    })
  }
  return out
}

/**
 * Cohere's reasoning guide. `thinking.token_budget` is budget mode, and
 * thinking can be turned off, so it is not mandatory. No effort names are
 * published. A page that does not state `token_budget` configures nothing.
 *
 * The guide names one model in its examples but says "Cohere's reasoning
 * models are hybrid", enabled or disabled. While it says so, the same
 * configuration is kept under `COHERE_ANY_REASONING` for the other models
 * the listing flags `reasoning` (Command A+, North Mini Code).
 */
export const COHERE_ANY_REASONING = '*'

export function parseCohereReasoning(
  markdown: string,
): Map<string, ModelReasoning> {
  const out = new Map<string, ModelReasoning>()
  if (!/token_budget/.test(markdown)) return out
  if (!/"type":\s*"disabled"|turns off thinking/i.test(markdown)) return out
  const ids = new Set<string>()
  for (const match of markdown.matchAll(
    /`([a-z0-9][a-z0-9._-]*-\d{2}-\d{4})`/g,
  )) {
    if (match[1]) ids.add(match[1])
  }
  for (const match of markdown.matchAll(/model="([^"]+)"/g)) {
    if (match[1]) ids.add(match[1])
  }
  if (
    /Cohere's reasoning models are \*hybrid\*, meaning reasoning can be enabled \([^)]*\) or disabled/.test(
      markdown,
    )
  ) {
    ids.add(COHERE_ANY_REASONING)
  }
  for (const id of ids) {
    out.set(id, { mode: 'budget', mandatory: false })
  }
  return out
}

const BYTEPLUS_EFFORT = /^(none|minimal|low|medium|high|xhigh|max)$/
const BYTEPLUS_MODEL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*-\d{4,}$/

/**
 * The ModelArk deep-thinking page is a Lark doc (`curDoc.Content`). Under
 * the "Adjust chain-of-thought length" heading, effort names are the
 * published value list and model ids are the cells of that section's
 * "Supported models" table, nothing else on the page (#432). Missing either
 * configures nothing, so the load fails closed.
 */
export function parseByteplusReasoning(
  body: string,
): Map<string, ModelReasoning> {
  const doc = JSON.parse(
    pricingContent(body, 'byteplus reasoning page'),
  ) as ByteplusDoc
  const efforts: Array<string> = []
  const ids: Array<string> = []
  let inSection = false
  for (const op of doc.data['0']?.ops ?? []) {
    if (typeof op.insert !== 'string') continue
    const text = op.insert.trim()
    if (!inSection) {
      inSection = /^adjust chain-of-thought length$/i.test(text)
      continue
    }
    if (op.attributes?.heading) break
    // Effort names are the value list, which ends where the table begins.
    if (
      ids.length === 0 &&
      BYTEPLUS_EFFORT.test(text) &&
      !efforts.includes(text)
    ) {
      efforts.push(text)
    }
    const spec = op.attributes?.aceTable
    const [header, ...rows] = spec ? (tableRows(doc, spec) ?? []) : []
    if (!/^supported models$/i.test(header?.[0] ?? '')) continue
    for (const cell of rows.map((row) => row[0] ?? '')) {
      for (const token of cell.split(/[\s*]+/)) {
        if (BYTEPLUS_MODEL_ID.test(token) && !ids.includes(token)) {
          ids.push(token)
        }
      }
    }
  }
  const out = new Map<string, ModelReasoning>()
  if (efforts.length === 0) return out
  const reasoning: ModelReasoning = {
    mode: 'effort',
    mandatory: !efforts.includes('none'),
    efforts,
  }
  for (const id of ids) out.set(id, reasoning)
  return out
}

async function loadReasoningMap(
  kv: KVNamespace | undefined,
  url: string,
  source: string,
  parse: (body: string) => Map<string, ModelReasoning>,
  fetchBody: (url: string) => Promise<string> = fetchText,
  cached: typeof cachedDocs = cachedDocs,
): Promise<{
  byId: Record<string, ModelReasoning>
  hash: string
  url: string
}> {
  return cached(kv, url, async () => {
    const body = await fetchBody(url)
    const parsed = parse(body)
    assertParsed(parsed, source)
    return { byId: Object.fromEntries(parsed), hash: await sha256Text(body) }
  }).then((doc) => ({ ...doc, url }))
}

function lookup(doc: {
  byId: Record<string, ModelReasoning>
  hash: string
  url: string
}): (rawId: string, capability: boolean) => Partial<ModelInfo> {
  return (rawId, capability) =>
    reasoningFactsFor(rawId, doc.byId, doc, capability)
}

export async function mistralModelReasoning(
  kv?: KVNamespace,
  cached: typeof cachedDocs = cachedDocs,
) {
  const doc = await loadReasoningMap(
    kv,
    MISTRAL_REASONING_URL,
    'mistral reasoning page',
    parseMistralReasoning,
    fetchText,
    cached,
  )
  return lookup(doc)
}

/**
 * A Groq model page's own effort list: "low/medium/high reasoning effort"
 * on openai/gpt-oss-safeguard-20b. No such sentence is null. A word in it
 * that is not an effort name throws.
 */
export function parseGroqPageEfforts(markdown: string): Array<string> | null {
  const list = markdown.match(
    /\b([a-z]+(?:\/[a-z]+)+) reasoning effort\b/i,
  )?.[1]
  if (!list) return null
  const efforts = list.toLowerCase().split('/')
  if (
    !efforts.every((effort) =>
      /^(none|minimal|low|medium|high|xhigh|max)$/.test(effort),
    )
  ) {
    throw new Error(`groq model page: unreadable reasoning effort "${list}"`)
  }
  return efforts
}

/**
 * The reasoning guide's effort tables. A model the guide lists as reasoning
 * but gives no options is read from its own model page (#432): the guide
 * says `reasoning_effort` is GPT-OSS 20B/120B only, while the
 * gpt-oss-safeguard-20b page states low/medium/high, and a live probe on
 * 2026-10-23 accepted them. `mandatory` stays null: no page says `none`
 * is refused. A guide or page that fails to load marks reasoning
 * `unavailable` (kept) and is counted in `run`.
 */
export async function groqModelReasoning(
  kv: KVNamespace | undefined,
  run: DocsRun,
  rawIds: Array<string>,
): Promise<(rawId: string, capability: boolean) => Partial<ModelInfo>> {
  // Its own cache key: this entry's shape (with `listed`) is not the plain
  // reasoning map other loaders cache under the URL.
  const guide = await tryDocs(run, GROQ_REASONING_URL, (cached) =>
    cached(kv, `${GROQ_REASONING_URL}#models`, async () => {
      const body = await fetchText(GROQ_REASONING_URL)
      const parsed = parseGroqReasoning(body)
      assertParsed(parsed, 'groq reasoning page')
      return {
        byId: Object.fromEntries(parsed),
        listed: groqSupportedModels(body).map((model) => model.id),
        hash: await sha256Text(body),
      }
    }),
  )
  if (!guide) return () => unavailable('reasoning')
  const doc = { ...guide, url: GROQ_REASONING_URL }
  const fromPages = new Map<string, Partial<ModelInfo>>()
  const pageIds = guide.listed.filter(
    (id) => !(id in guide.byId) && rawIds.includes(id),
  )
  await Promise.all(
    pageIds.map(async (id) => {
      const url = groqModelPageUrl(id)
      const page = await tryDocs(run, url, (cached) =>
        cached(kv, url, async () => {
          const body = await fetchText(url)
          return {
            efforts: parseGroqPageEfforts(body),
            hash: await sha256Text(body),
          }
        }),
      )
      if (!page) {
        fromPages.set(id, unavailable('reasoning'))
      } else if (page.efforts) {
        const reasoning: ModelReasoning = {
          mode: 'effort',
          mandatory: null,
          efforts: page.efforts,
        }
        fromPages.set(
          id,
          reasoningFactsFor(
            id,
            { [id]: reasoning },
            { url, hash: page.hash },
            true,
          ),
        )
      }
    }),
  )
  return (rawId, capability) =>
    fromPages.get(rawId) ?? reasoningFactsFor(rawId, doc.byId, doc, capability)
}

export async function cohereModelReasoning(kv?: KVNamespace) {
  const doc = await loadReasoningMap(
    kv,
    COHERE_REASONING_URL,
    'cohere reasoning page',
    parseCohereReasoning,
  )
  const any = COHERE_ANY_REASONING in doc.byId
  return (rawId: string, capability: boolean): Partial<ModelInfo> =>
    reasoningFactsFor(
      capability && any && !(rawId in doc.byId) ? COHERE_ANY_REASONING : rawId,
      doc.byId,
      doc,
      capability,
    )
}

export async function byteplusModelReasoning(kv?: KVNamespace) {
  const doc = await loadReasoningMap(
    kv,
    BYTEPLUS_REASONING_URL,
    'byteplus reasoning page',
    parseByteplusReasoning,
    fetchByteplusDoc,
  )
  return lookup(doc)
}
