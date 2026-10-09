/**
 * NVIDIA NIM — ids from the provider's public models list, facts from each
 * model's card on build.nvidia.com, and the per-model OpenAPI document on
 * docs.api.nvidia.com when that model has a reference-index row.
 *
 * The list publishes id and created only. A card's markdown twin
 * (`build.nvidia.com/<id>.md`) names the route in its Prototype section.
 * Specifications and Capabilities are bullet lists on newer cards. Older
 * cards use the same labels (`Input Type`, `Context length`, `Max Output
 * Tokens`, a Reasoning Mode table) outside those lists. A reasoning object
 * is stored only when a label or the model's own request schema states the
 * control. NVIDIA publishes no per-token price for the hosted trial API.
 */
import { explicitCardReplay, replayRequestMap } from '../provider-replay.ts'
import { discoverNvidiaSitemap } from '../nvidia-sitemap.ts'
import type { Activity } from '#/db/schema.ts'

import { tagDocsFacts } from '../fact-sources.ts'
import {
  assertParsed,
  docsRun,
  mapConcurrent,
  markdownSection,
  markdownTableRows,
  tokenCount,
  tryDocs,
  unavailable,
} from '../model-facts.ts'
import type { DocsRun } from '../model-facts.ts'
import { fetchJson, sha256Text } from '../types.ts'
import type {
  DocsFailures,
  ListModelsResult,
  ModelFact,
  ModelInfo,
  ModelReasoning,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'
import {
  classifyNvidiaOperation,
  fetchNvidiaText,
  nvidiaInferNamesModel,
  nvidiaStatedModelIds,
  nvidiaModelSpec,
  NVIDIA_REFERENCE_INDEXES,
  parseNvidiaInfer,
  parseNvidiaReferenceIndex,
} from '../nvidia-openapi.ts'
import type { NvidiaIndexRow, NvidiaInferFacts } from '../nvidia-openapi.ts'

export const NVIDIA_MODELS_URL = 'https://integrate.api.nvidia.com/v1/models'
export const NVIDIA_CARD_BASE = 'https://build.nvidia.com/'

// A card renders in about ten seconds.
const CARD_TIMEOUT_MS = 60_000
const INFER_CONCURRENCY = 3

const CAPABILITY_FLAGS: Record<string, string> = {
  'Function Calling': 'tools',
  'Structured Output': 'structured_outputs',
  Reasoning: 'reasoning',
}

const MODALITY_WORDS = new Set(['text', 'image', 'video', 'audio'])

const CARD_FACTS: Array<ModelFact> = [
  'activity',
  'contextWindow',
  'maxOutput',
  'modalities',
  'capabilities',
  'reasoning',
  'requestMap',
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseNvidiaModels(payload: unknown): Array<ModelInfo> {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error('nvidia: models payload has no data array')
  }
  const models: Array<ModelInfo> = []
  for (const row of payload.data) {
    if (!isRecord(row) || typeof row.id !== 'string' || row.id.length === 0) {
      continue
    }
    models.push({
      rawId: row.id,
      releasedAt:
        typeof row.created === 'number' && row.created > 0 ? row.created : null,
      pricing: null,
    })
  }
  if (models.length === 0) {
    throw new Error('nvidia: models payload listed no ids')
  }
  return models
}

type CardFacts = Pick<
  ModelInfo,
  | 'activity'
  | 'contextWindow'
  | 'maxOutput'
  | 'modalities'
  | 'capabilities'
  | 'exactCapabilities'
  | 'reasoning'
  | 'requestMap'
>

/** `- **Label:** value` lines of one card section. */
function bullets(markdown: string, heading: string): Map<string, string> {
  return new Map(
    [
      ...markdownSection(markdown, heading).matchAll(
        /^- \*\*(.+?):\*\* (.+)$/gm,
      ),
    ].map((match) => [match[1] ?? '', (match[2] ?? '').trim()]),
  )
}

/**
 * `##` or `###` section. The heading is exactly that word (`Input(s):`),
 * unless `loose` is set for a title that carries a parenthetical
 * (`Reasoning Mode (`enable_thinking`)`).
 */
function cardSection(markdown: string, heading: string, loose = false): string {
  const text = `\n${markdown}`
  const tail = loose ? '[^\\n]*' : '(?:\\(s\\))?:?\\s*'
  const headingMatch = new RegExp(
    `(?:^|\\n)#{2,3} ${heading}${tail}\\n`,
    'i',
  ).exec(text)
  if (headingMatch) {
    const rest = text.slice(headingMatch.index + headingMatch[0].length)
    const end = rest.search(/\n#{2,3} /)
    return end < 0 ? rest : rest.slice(0, end)
  }
  // Older cards use a bold title (`**Input**`) instead of a heading.
  if (loose) return ''
  const boldMatch = new RegExp(
    `(?:^|\\n)\\*\\*${heading}\\*\\*\\s*\\n`,
    'i',
  ).exec(text)
  if (!boldMatch) return ''
  const rest = text.slice(boldMatch.index + boldMatch[0].length)
  const end = rest.search(/\n\*\*[A-Za-z][^*\n]*\*\*\s*(?:\n|$)/)
  return end < 0 ? rest : rest.slice(0, end)
}

function labeledValue(
  section: string,
  labels: Array<string>,
): string | undefined {
  for (const label of labels) {
    const match = new RegExp(
      `(?:^|\\n)\\s*[-*]*\\s*\\*{0,2}${label}\\*{0,2}\\s*:\\s*\\*{0,2}\\s*([^\\n]+)`,
      'i',
    ).exec(section)
    const value = match?.[1]?.replace(/<br\s*\/?>/gi, ' ').trim()
    if (value) return value
  }
  return undefined
}

function modalityWords(cell: string | undefined): Array<string> {
  if (!cell) return []
  const cleaned = cell
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*]/g, (item) => item.slice(1, -1))
  const out: Array<string> = []
  for (const part of cleaned.split(/[,/|+]|\band\b/i)) {
    const word = part
      .trim()
      .toLowerCase()
      .replace(/[^a-z]/g, '')
      .replace(/s$/, '')
    if (MODALITY_WORDS.has(word) && !out.includes(word)) out.push(word)
  }
  return out
}

function effortWords(text: string | undefined): Array<string> {
  if (!text) return []
  const out: Array<string> = []
  for (const match of text
    .toLowerCase()
    .matchAll(/\b(none|off|disabled|minimal|low|medium|high|xhigh|max)\b/g)) {
    const word = match[1]
    if (word && !out.includes(word)) out.push(word)
  }
  return out
}

function contextWindowOf(markdown: string): number | undefined {
  const specs = bullets(markdown, 'Specifications')
  const fromSpecs = tokenCount(
    specs.get('Context Length') ?? specs.get('Context window'),
  )
  if (fromSpecs) return fromSpecs
  const input = cardSection(markdown, 'Input')
  const labeled = [
    tokenCount(labeledValue(input, ['Max Input Tokens'])),
    tokenCount(
      markdown.match(
        /Input Context Length \(ISL\):\**\s*([\d,.]+\s*[kKmM]?)/,
      )?.[1],
    ),
    tokenCount(labeledValue(markdown, ['Max Sequence Length'])),
    tokenCount(
      markdownTableRows(markdown).find((row) =>
        /^context length$/i.test((row[0] ?? '').replace(/\*/g, '').trim()),
      )?.[1],
    ),
    tokenCount(markdown.match(/\*\*Context window:\*\*\s*([^\n]+)/i)?.[1]),
    tokenCount(
      input.match(
        /(?:^|\n)\s*[-*]\s+\*{0,2}Context length:\*{0,2}\s*([^\n]+)/i,
      )?.[1],
    ),
    tokenCount(input.match(/Context length up to\s+([\d,.]+\s*[kKmM]?)/i)?.[1]),
    tokenCount(
      markdown.match(/context length of up to\s+([\d,.]+\s*[kKmM]?)/i)?.[1],
    ),
  ]
  return labeled.find((value) => value !== null)
}

/** A format cell is a modality list only when every word is one. */
function modalityCell(cell: string | undefined): Array<string> {
  const words = modalityWords(cell)
  if (!cell || words.length === 0) return []
  const tokens = cell
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*]/g, ' ')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((token) => token.length > 0)
    .map((token) => token.replace(/s$/, ''))
  if (tokens.some((token) => !MODALITY_WORDS.has(token))) return []
  return words
}

const INPUT_TYPE_LABELS = ['Input Type\\(s\\)', 'Input Types', 'Input Type']
const OUTPUT_TYPE_LABELS = ['Output Type\\(s\\)', 'Output Types', 'Output Type']
const INPUT_FORMAT_LABELS = [
  'Input Format\\(s\\)',
  'Input Formats',
  'Input Format',
]
const OUTPUT_FORMAT_LABELS = [
  'Output Format\\(s\\)',
  'Output Formats',
  'Output Format',
]

function sideModalities(
  specs: Map<string, string>,
  specKey: string,
  section: string,
  typeLabels: Array<string>,
  formatLabels: Array<string>,
): Array<string> {
  const fromSpecs = modalityWords(specs.get(specKey))
  if (fromSpecs.length > 0) return fromSpecs
  const typed = modalityWords(labeledValue(section, typeLabels))
  if (typed.length > 0) return typed
  // `String` and `RGB` are not modalities. A cell that is only
  // text/image/video/audio is the older cards' type line.
  return modalityCell(labeledValue(section, formatLabels))
}

function modalitiesOf(
  markdown: string,
): { input: Array<string>; output: Array<string> } | undefined {
  const specs = bullets(markdown, 'Specifications')
  const input = sideModalities(
    specs,
    'Input',
    cardSection(markdown, 'Input'),
    INPUT_TYPE_LABELS,
    INPUT_FORMAT_LABELS,
  )
  const output = sideModalities(
    specs,
    'Output',
    cardSection(markdown, 'Output'),
    OUTPUT_TYPE_LABELS,
    OUTPUT_FORMAT_LABELS,
  )
  if (input.length === 0 || output.length === 0) return undefined
  return { input, output }
}

function maxOutputOf(markdown: string): number | undefined {
  const match = cardSection(markdown, 'Output').match(
    /\*\*Max Output Tokens:\*\*\s*([\d,]+(?:\.\d+)?\s*[kKmM]?)/,
  )
  return tokenCount(match?.[1]) ?? undefined
}

function reasoningFromCard(markdown: string): ModelReasoning | undefined {
  for (const row of markdownTableRows(markdown)) {
    const label = (row[0] ?? '').replace(/\*/g, '').trim()
    const value = row[1] ?? ''
    if (
      /^reasoning mode$/i.test(label) &&
      /enable_thinking/i.test(value) &&
      /true/i.test(value) &&
      /false/i.test(value)
    ) {
      return { mode: 'toggle', mandatory: false }
    }
  }
  const modeSection = cardSection(markdown, 'Reasoning Mode', true)
  if (
    /enable_thinking/i.test(modeSection) &&
    /false/i.test(modeSection) &&
    /true|on/i.test(modeSection)
  ) {
    return { mode: 'toggle', mandatory: false }
  }
  const listed =
    effortWords(
      markdown.match(
        /reasoning_effort`, which accepts ([\s\S]{0,200}?)(?:\.|and defaults)/,
      )?.[1],
    ).length > 0
      ? effortWords(
          markdown.match(
            /reasoning_effort`, which accepts ([\s\S]{0,200}?)(?:\.|and defaults)/,
          )?.[1],
        )
      : effortWords(
            markdown.match(
              /configurable\s+([^.\n]{0,80}?)\s+reasoning effort/i,
            )?.[1],
          ).length > 0
        ? effortWords(
            markdown.match(
              /configurable\s+([^.\n]{0,80}?)\s+reasoning effort/i,
            )?.[1],
          )
        : effortWords(
            markdown.match(
              /\*\*Configurable reasoning effort:\*\*[^\n]*\(([^)]+)\)/i,
            )?.[1],
          )
  if (listed.length === 0) return undefined
  const off = listed.some((effort) => /^(none|off|disabled)$/i.test(effort))
  const always = /thinking is always enabled/i.test(markdown)
  return {
    mode: 'effort',
    mandatory: off ? false : always ? true : null,
    efforts: listed,
  }
}

function activityFromCard(markdown: string): Activity | null {
  const prototype = markdownSection(`\n${markdown}`, 'Prototype')
  if (prototype.includes('integrate.api.nvidia.com/v1/chat/completions')) {
    return 'chat'
  }
  if (/api\.nvidia\.com\/v1\/\S*embeddings/.test(prototype)) return 'embeddings'
  if (/integrate\.api\.nvidia\.com\/v1\/completions\b/.test(prototype)) {
    return 'chat'
  }
  if (
    /ai\.api\.nvidia\.com\/v1\/vlm\//.test(prototype) &&
    /"role"\s*:\s*"user"/.test(prototype)
  ) {
    return 'chat'
  }
  const output = labeledValue(cardSection(markdown, 'Output'), [
    'Output Type\\(s\\)',
    'Output Types',
    'Output Type',
  ])
  if (
    output !== undefined &&
    /\bfloat/i.test(output) &&
    markdown.slice(0, 1500).toLowerCase().includes('embedding')
  ) {
    return 'embeddings'
  }
  return null
}

/** The facts one model card states. Absent sections leave their facts out. */
export function parseNvidiaCard(markdown: string): CardFacts {
  const capabilities = bullets(markdown, 'Capabilities')
  const contextWindow = contextWindowOf(markdown)
  const modalities = modalitiesOf(markdown)
  const maxOutput = maxOutputOf(markdown)
  const reasoning = reasoningFromCard(markdown)
  return {
    activity: activityFromCard(markdown),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxOutput !== undefined ? { maxOutput } : {}),
    ...(modalities ? { modalities } : {}),
    ...(capabilities.size > 0
      ? {
          exactCapabilities: true,
          capabilities: [...capabilities].flatMap(([label, value]) => {
            const flag = CAPABILITY_FLAGS[label]
            return flag && value === 'Supported' ? [flag] : []
          }),
        }
      : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(explicitCardReplay(markdown) ? { requestMap: replayRequestMap() } : {}),
  }
}

/**
 * Card slugs keep the id, or write its dots as `_` or `-`
 * (`z-ai/glm-5.3` is at `z-ai/glm-5-3`). NVIDIA publishes no id-to-slug
 * map, so try each; a listed id with no card gets no facts.
 */
function cardSlugs(rawId: string): Array<string> {
  return [
    ...new Set([rawId, rawId.replaceAll('.', '_'), rawId.replaceAll('.', '-')]),
  ]
}

async function fetchCard(
  rawId: string,
): Promise<{ url: string; markdown: string; hash: string } | { url: null }> {
  for (const slug of cardSlugs(rawId)) {
    const url = `${NVIDIA_CARD_BASE}${slug}`
    // Providers poll in sequence; a hung card must not stall the rest.
    const response = await fetch(`${url}.md`, {
      signal: AbortSignal.timeout(CARD_TIMEOUT_MS),
    })
    if (response.status === 404) continue
    if (!response.ok) {
      throw new Error(
        `fetch failed: ${url}.md → ${String(response.status)} ${response.statusText}`,
      )
    }
    const markdown = await response.text()
    if (!markdown.startsWith('---\n')) {
      // Some cards have no markdown twin: the site answers 200 with its
      // HTML not-found page. Any other body is a failed load, never a card.
      if (markdown.includes('NEXT_HTTP_ERROR_FALLBACK;404')) continue
      throw new Error(`nvidia: ${url}.md is not a markdown card`)
    }
    // The slug is a guess, so the card must name itself as that page.
    if (!markdown.includes(`\ncanonical: "${url}"\n`)) continue
    return { url, markdown, hash: await sha256Text(markdown) }
  }
  return { url: null }
}

function mergeDocs(runs: Array<DocsRun>): DocsFailures | undefined {
  const failed = runs.reduce((sum, run) => sum + run.failed, 0)
  const skipped = runs.reduce((sum, run) => sum + run.skipped, 0)
  if (failed + skipped === 0) return undefined
  return {
    failed,
    skipped,
    first: runs.flatMap((run) => run.first).slice(0, 5),
  }
}

function markUnavailable(model: ModelInfo, facts: Array<ModelFact>): ModelInfo {
  if (facts.length === 0) return model
  return {
    ...model,
    absent: {
      ...model.absent,
      ...Object.fromEntries(facts.map((fact) => [fact, 'unavailable'])),
    },
  }
}

/**
 * The card's labeled control stays when this model's schema agrees. An
 * off value in the schema (`none`) replaces a card that did not state one.
 * A card that says thinking is always on sets `mandatory` on the same
 * effort list. Otherwise the schema is the request contract.
 */
function mergeReasoning(
  card: ModelReasoning | undefined,
  schema: ModelReasoning | undefined,
): { reasoning: ModelReasoning; source: 'card' | 'schema' } | undefined {
  if (schema && card) {
    if (schema.mandatory === false && card.mandatory !== false) {
      return { reasoning: schema, source: 'schema' }
    }
    if (
      card.mandatory === true &&
      schema.mode === card.mode &&
      schema.mandatory == null
    ) {
      return {
        reasoning: { ...schema, mandatory: true },
        source: 'card',
      }
    }
    if (card.mode === schema.mode) return { reasoning: card, source: 'card' }
    return { reasoning: schema, source: 'schema' }
  }
  if (schema) return { reasoning: schema, source: 'schema' }
  if (card) return { reasoning: card, source: 'card' }
  return undefined
}

const SCHEMA_GAPS: Array<ModelFact> = [
  'maxOutput',
  'reasoning',
  'schemaEndpointId',
]

function schemaGaps(model: ModelInfo): Array<ModelFact> {
  return SCHEMA_GAPS.filter((fact) => model[fact] == null)
}

function clearAbsent(model: ModelInfo, facts: Array<ModelFact>): ModelInfo {
  if (!model.absent) return model
  const absent = { ...model.absent }
  for (const fact of facts) delete absent[fact]
  if (Object.keys(absent).length === 0) {
    const { absent: _dropped, ...rest } = model
    return rest
  }
  return { ...model, absent }
}

function applyInfer(
  model: ModelInfo,
  infer: NvidiaInferFacts,
  inferUrl: string,
  inferHash: string,
): ModelInfo {
  const reasoning = mergeReasoning(
    model.reasoning ?? undefined,
    infer.reasoning,
  )
  const maxFromSchema = infer.maxOutput !== undefined
  const activity = model.activity ?? infer.activity
  const bind =
    infer.activity !== null &&
    (model.activity == null || model.activity === infer.activity)
  const factSources = { ...model.factSources }
  const schemaSource = {
    derivation: 'docs-derived' as const,
    sourceUrl: inferUrl,
    sourceHash: inferHash,
  }
  if (maxFromSchema)
    factSources.maxOutput = { ...schemaSource, path: 'max_tokens' }
  if (reasoning?.source === 'schema') {
    factSources.reasoning = { ...schemaSource, path: 'reasoning' }
  }
  const filled: Array<ModelFact> = []
  if (activity && model.activity == null) filled.push('activity')
  if (maxFromSchema) filled.push('maxOutput')
  if (reasoning) filled.push('reasoning')
  if (bind) filled.push('schemaEndpointId')
  return clearAbsent(
    {
      ...model,
      ...(activity ? { activity } : {}),
      ...(maxFromSchema ? { maxOutput: infer.maxOutput } : {}),
      ...(reasoning ? { reasoning: reasoning.reasoning } : {}),
      ...(bind ? { schemaEndpointId: model.rawId } : {}),
      ...(Object.keys(factSources).length > 0 ? { factSources } : {}),
    },
    filled,
  )
}

async function loadIndex(
  kv: KVNamespace | undefined,
  docs: DocsRun,
): Promise<{ rows: Array<NvidiaIndexRow>; failed: boolean }> {
  const loaded = await mapConcurrent(NVIDIA_REFERENCE_INDEXES, 1, async (url) =>
    tryDocs(docs, url, (cached) => cached(kv, url, () => fetchNvidiaText(url))),
  )
  const rows: Array<NvidiaIndexRow> = []
  const seen = new Set<string>()
  let parsed = 0
  for (const markdown of loaded) {
    if (markdown === null) continue
    parsed++
    for (const row of parseNvidiaReferenceIndex(markdown)) {
      if (seen.has(row.rawId)) continue
      seen.add(row.rawId)
      rows.push(row)
    }
  }
  return { rows, failed: parsed === 0 && docs.failed + docs.skipped > 0 }
}

async function listModels(
  _env: ProviderSecrets,
  kv?: KVNamespace,
): Promise<ListModelsResult> {
  const listed = parseNvidiaModels(await fetchJson(NVIDIA_MODELS_URL))
  const cardDocs = docsRun()
  const specDocs = docsRun()
  const index = await loadIndex(kv, specDocs)
  const indexed = new Set(index.rows.map((row) => row.rawId))
  const discovered = await discoverNvidiaSitemap(
    listed.map((model) => model.rawId).filter((id) => !indexed.has(id)),
    kv,
    specDocs,
  )
  index.rows.push(...discovered.rows)
  const byInfer = new Map(index.rows.map((row) => [row.rawId, row.inferUrl]))
  // A card takes about ten seconds to render. The six-hour cache per card
  // (misses included) keeps that off most polls.
  // A card that fails to load is that model's alone: its row keeps the
  // stored card facts and the next poll retries.
  const models = await mapConcurrent(
    listed,
    8,
    async (model): Promise<ModelInfo> => {
      const source = `${NVIDIA_CARD_BASE}${model.rawId}.md`
      const card = await tryDocs(cardDocs, source, (cached) =>
        cached(kv, source, () => fetchCard(model.rawId)),
      )
      // A throw keeps stored card facts. A missing card is not a failure.
      if (card === null) return { ...model, ...unavailable(...CARD_FACTS) }
      if (card.url === null) return model
      const facts = parseNvidiaCard(card.markdown)
      return {
        ...model,
        ...facts,
        factSources: tagDocsFacts(facts, card.url, card.hash),
      }
    },
  )
  // Infer pages are a second host. Keep them off the card concurrency and
  // off the card failure budget.
  const merged = await mapConcurrent(
    models,
    INFER_CONCURRENCY,
    async (model) => {
      const inferUrl = byInfer.get(model.rawId)
      if (!inferUrl) {
        return index.failed || discovered.unavailable.includes(model.rawId)
          ? markUnavailable(model, schemaGaps(model))
          : model
      }
      const page = `${inferUrl}.md`
      const checked = await tryDocs(specDocs, page, async (cached) => {
        const loaded = await cached(kv, page, () => fetchNvidiaText(page))
        const infer = parseNvidiaInfer(loaded)
        if (!infer)
          throw new Error(
            'nvidia: reference infer page has no OpenAPI document: ' + page,
          )
        if (!nvidiaInferNamesModel(model.rawId, infer.document))
          throw new Error(
            'nvidia: reference infer page identity conflict: ' +
              page +
              '; expected ' +
              model.rawId +
              '; stated ' +
              nvidiaStatedModelIds(infer.document).join(', '),
          )
        return { infer, hash: await sha256Text(loaded) }
      })
      if (checked === null) return markUnavailable(model, schemaGaps(model))
      return applyInfer(model, checked.infer, inferUrl, checked.hash)
    },
  )
  const parsed = new Map(
    merged.flatMap((model) => (model.activity ? [[model.rawId, model]] : [])),
  )
  // Zero rows with every card loaded is a reshaped site. With cards
  // failing it is the outage `docsFailures` already reports.
  if (parsed.size > 0 || cardDocs.failed + cardDocs.skipped === 0) {
    assertParsed(parsed, 'nvidia model cards')
  }
  return { models: merged, docsFailures: mergeDocs([cardDocs, specDocs]) }
}

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const warnings: Array<string> = []
  const indexes: Array<string> = []
  for (const url of NVIDIA_REFERENCE_INDEXES) {
    try {
      indexes.push(await fetchNvidiaText(url))
    } catch (error) {
      warnings.push(
        error instanceof Error ? error.message : `nvidia: ${url} failed`,
      )
    }
  }
  if (indexes.length === 0) {
    throw new Error('nvidia: reference indexes could not be fetched')
  }
  const listed = new Set(
    parseNvidiaModels(await fetchJson(NVIDIA_MODELS_URL)).map(
      (model) => model.rawId,
    ),
  )
  const wanted = new Map<string, string>()
  for (const markdown of indexes) {
    for (const row of parseNvidiaReferenceIndex(markdown)) {
      if (listed.has(row.rawId) && !wanted.has(row.rawId)) {
        wanted.set(row.rawId, row.inferUrl)
      }
    }
  }
  const discovery = await discoverNvidiaSitemap(
    [...listed].filter((id) => !wanted.has(id)),
  )
  for (const row of discovery.rows) wanted.set(row.rawId, row.inferUrl)
  for (const failure of discovery.failures.first)
    warnings.push(`nvidia: ${failure.source}: ${failure.error}`)
  const fetched = await mapConcurrent(
    [...wanted],
    INFER_CONCURRENCY,
    async ([rawId, inferUrl]) => {
      const page = `${inferUrl}.md`
      try {
        const markdown = await fetchNvidiaText(page)
        const infer = parseNvidiaInfer(markdown)
        if (!infer)
          throw new Error(
            'nvidia: reference infer page has no OpenAPI document: ' + page,
          )
        if (!nvidiaInferNamesModel(rawId, infer.document))
          throw new Error(
            'nvidia: reference infer page identity conflict: ' +
              page +
              '; expected ' +
              rawId +
              '; stated ' +
              nvidiaStatedModelIds(infer.document).join(', '),
          )
        const spec = nvidiaModelSpec(rawId, infer)
        if (!spec) return null
        return {
          spec,
          source: { url: page, hash: await sha256Text(markdown) },
        }
      } catch (error) {
        warnings.push(
          error instanceof Error ? error.message : `nvidia: ${page} failed`,
        )
        return null
      }
    },
  )
  const docs = fetched.filter((doc) => doc !== null)
  if (docs.length === 0) {
    throw new Error(
      'nvidia: per-model OpenAPI documents parsed 0 generation specs',
    )
  }
  return {
    specs: docs.map((doc) => doc.spec),
    sources: docs.map((doc) => doc.source),
    outputStrategy: 'post-200',
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}

export const provider: ProviderConfig = {
  id: 'nvidia',
  displayName: 'NVIDIA NIM',
  specSourceUrl: 'https://docs.api.nvidia.com/nim/',
  modelsEndpoint: NVIDIA_MODELS_URL,
  defaultDerivation: 'upstream-spec',
  // A poll can name a per-model route the spec sync has not stored yet.
  bindSyncedRoutesOnly: true,
  fetchSpec,
  listModels,
  classify: classifyNvidiaOperation,
}
