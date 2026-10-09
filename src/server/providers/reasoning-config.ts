/**
 * Reasoning objects for chat rows whose capabilities already say `reasoning`
 * (issue #110). Mode and effort names come only from a native listing or
 * docs page. A model the source does not configure stays null; `path:
 * 'silent'` records that the page was read and did not state a mode.
 */
import { ingestFailedEvent, noteIngest } from '../ingest/ingest-signals.ts'
import { emptySources } from './fact-sources.ts'
import { assertParsed, cachedDocs, markdownTableRows } from './model-facts.ts'
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
  const factSources: ModelFactSources = { ...(model.factSources ?? {}) }
  for (const patch of patches) {
    const { factSources: more, ...rest } = patch
    next = { ...next, ...rest }
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
): ModelReasoning | null {
  const reasoning = row.reasoning
  if (!reasoning || typeof reasoning !== 'object') return null
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

/** Groq reasoning page: per-model `reasoning_effort` tables. Ids the page lists as reasoning models but never gives options stay absent. */
export function parseGroqReasoning(
  markdown: string,
): Map<string, ModelReasoning> {
  const models: Array<NamedModel> = []
  const effortsById = new Map<string, Array<string>>()
  const conflicts = new Set<string>()
  for (const block of headingBlocks(markdown)) {
    if (block.title === 'Supported Models') {
      for (const row of markdownTableRows(block.body)) {
        const id = (row[0] ?? '').trim()
        if (!/^[A-Za-z0-9][A-Za-z0-9./_-]*$/.test(id) || id === 'Model ID') {
          continue
        }
        models.push({ id, label: linkLabel(row[1] ?? '') })
      }
      continue
    }
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

/** Pull the chain-of-thought section out of the docs HTML or a markdown fixture. */
export function byteplusReasoningSection(body: string): string {
  const text = body
    .replace(/\\u003C/gi, '<')
    .replace(/\\u003E/gi, '>')
    .replace(/\\u0026/gi, '&')
    .replace(/\\u002F/gi, '/')
    .replace(/\\n/g, '\n')
    .replace(/\\-/g, '-')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
  const headed = text.search(/(?:^|\n)## Adjust chain-of-thought length/i)
  const start =
    headed >= 0 ? headed : text.search(/adjust chain-of-thought length/i)
  if (start < 0) return ''
  const rest = text.slice(start)
  const end = rest.search(/\n## (?!Adjust)/)
  return end < 0 ? rest : rest.slice(0, end)
}

/**
 * Doc-center delta: each visible string is an `"insert":"..."` fragment.
 * Effort names are the published value list. Model ids are the dated ids
 * after that list. Markdown fixtures fall through to the table parser.
 */
function parseByteplusInserts(section: string): Map<string, ModelReasoning> {
  const out = new Map<string, ModelReasoning>()
  const inserts = [
    ...section.matchAll(/\\"insert\\":\\"([^\\"]*)\\"/g),
  ].flatMap((match) => {
    const text = (match[1] ?? '').replace(/\\n/g, '').trim()
    return text.length > 0 ? [text] : []
  })
  const efforts: Array<string> = []
  const ids: Array<string> = []
  let phase: 'seek' | 'values' | 'models' = 'seek'
  for (const insert of inserts) {
    if (phase === 'seek') {
      if (insert === 'reasoning_effort' || insert === 'reasoning.effort') {
        phase = 'values'
      }
      continue
    }
    if (phase === 'values') {
      if (/the table below|^supported models$/i.test(insert)) {
        phase = 'models'
        continue
      }
      if (
        /^(none|minimal|low|medium|high|xhigh|max)$/.test(insert) &&
        !efforts.includes(insert)
      ) {
        efforts.push(insert)
      }
      continue
    }
    if (
      /^[a-z0-9]+(?:-[a-z0-9]+)*-\d{4,}$/.test(insert) &&
      !ids.includes(insert)
    ) {
      ids.push(insert)
    }
  }
  if (efforts.length === 0 || ids.length === 0) return out
  const reasoning: ModelReasoning = {
    mode: 'effort',
    mandatory: !efforts.includes('none'),
    efforts,
  }
  for (const id of ids) out.set(id, reasoning)
  return out
}

export function parseByteplusReasoning(
  body: string,
): Map<string, ModelReasoning> {
  const section = byteplusReasoningSection(body)
  const out = new Map<string, ModelReasoning>()
  if (!section) return out
  const inserted = parseByteplusInserts(section)
  if (inserted.size > 0) return inserted
  const [values = ''] = section.split(/\| ?Supported models/i)
  const efforts: Array<string> = []
  for (const line of values.split('\n')) {
    const name = line.match(/^\*\s*`([a-z]+)`/)?.[1]
    if (name && !efforts.includes(name)) efforts.push(name)
  }
  if (efforts.length === 0) return out
  const reasoning: ModelReasoning = {
    mode: 'effort',
    mandatory: !efforts.includes('none'),
    efforts,
  }
  let inTable = false
  for (const row of markdownTableRows(section)) {
    const head = (row[0] ?? '').replace(/\\/g, '').trim()
    if (/^supported models$/i.test(head)) {
      inTable = true
      continue
    }
    if (!inTable) continue
    if (/^(api|example)$/i.test(head)) break
    for (const match of head.matchAll(/`([a-z0-9]+(?:-[a-z0-9]+)*-\d{4,})`/g)) {
      const id = match[1]
      if (id) out.set(id, reasoning)
    }
  }
  return out
}

async function loadReasoningMap(
  kv: KVNamespace | undefined,
  url: string,
  source: string,
  parse: (body: string) => Map<string, ModelReasoning>,
): Promise<{
  byId: Record<string, ModelReasoning>
  hash: string
  url: string
}> {
  return cachedDocs(kv, url, async () => {
    const body = await fetchText(url)
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

export async function mistralModelReasoning(kv?: KVNamespace) {
  const doc = await loadReasoningMap(
    kv,
    MISTRAL_REASONING_URL,
    'mistral reasoning page',
    parseMistralReasoning,
  )
  return lookup(doc)
}

export async function groqModelReasoning(kv?: KVNamespace) {
  const doc = await loadReasoningMap(
    kv,
    GROQ_REASONING_URL,
    'groq reasoning page',
    parseGroqReasoning,
  )
  return lookup(doc)
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
  )
  return lookup(doc)
}
