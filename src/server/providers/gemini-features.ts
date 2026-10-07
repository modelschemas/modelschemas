/**
 * Gemini thinking configuration and Google-hosted tools (issue #77).
 *
 * Tools: every model page (`/gemini-api/docs/models/{slug}.md.txt`) has a
 * Capabilities row of `**[Name](url)** Supported|Not supported` pairs.
 * Thinking: the generateContent thinking page has a `thinkingLevel` table
 * whose columns name Gemini 3 families, and a `thinkingBudget` table whose
 * rows name Gemini 2.5 families. Both key by family, so an id resolves to
 * the longest family it extends with a `-preview…`/`-latest`/`-NNN` suffix.
 * `mandatory` on a thinking-level column is true only when the page's prose
 * says that family cannot turn thinking off.
 * A model page that lists thinking levels in backticks fills a family the
 * table does not name. Modalities: the same page's `Supported data types`
 * row, bound to the model-code and version ids on that page, and to the
 * endpoint ids the models index names for that page.
 */
import {
  assertParsed,
  cachedDocs,
  docsReport,
  docsRun,
  mapConcurrent,
  markdownTableRows,
  tryDocs,
  unavailable,
} from './model-facts.ts'
import { fetchText, sha256Text } from './types.ts'
import type {
  DocsFailures,
  FactSource,
  ModelFact,
  ModelFactSources,
  ModelInfo,
  ModelReasoning,
} from './types.ts'

export const GEMINI_MODELS_INDEX_URL =
  'https://ai.google.dev/gemini-api/docs/models.md.txt'
export const GEMINI_THINKING_URL =
  'https://ai.google.dev/gemini-api/docs/generate-content/thinking.md.txt'

/** Capabilities entry → generateContent `Tool` field. */
const TOOL_FIELDS: Record<string, string> = {
  'Code execution': 'codeExecution',
  'Computer use': 'computerUse',
  'File search': 'fileSearch',
  'Grounding with Google Maps': 'googleMaps',
  'Search grounding': 'googleSearch',
  'URL context': 'urlContext',
}

/** Tool fields a model page marks Supported (including "(Preview)"). */
export function parsePageTools(markdown: string): Array<string> {
  const row = markdown
    .split('\n')
    .find((line) => line.startsWith('| Capabilities |'))
  if (!row) return []
  const out: Array<string> = []
  for (const m of row.matchAll(/\*\*\[([^\]]+)\]\([^)]*\)\*\*\s*([^*|]*)/g)) {
    const field = TOOL_FIELDS[m[1] ?? '']
    if (field && (m[2] ?? '').trim().startsWith('Supported')) out.push(field)
  }
  return out
}

/** Words a `Supported data types` cell uses → medium, in stored order. */
const MEDIA: Record<string, string> = {
  text: 'text',
  image: 'image',
  images: 'image',
  audio: 'audio',
  video: 'video',
  videos: 'video',
  pdf: 'file',
  pdfs: 'file',
  document: 'file',
  documents: 'file',
}
const MEDIA_ORDER = [...new Set(Object.values(MEDIA))]

/**
 * Word-level timestamp metadata on the transcribe page. It is not a medium.
 * Dropping only this phrase keeps Text and Audio; any other unknown word
 * still rejects the whole list.
 */
const NOT_MEDIA = new Set(['word annotation', 'word annotations'])

/**
 * `Text, Image, Video, Audio, and PDF` → media, or null on any other word.
 * A parenthetical is a qualifier (`Audio (MP3)`, `Video (up to 10s)`) and is
 * dropped, unless it names a medium itself (`Text (and Image, Audio)`): then
 * the list is inside it and the cell is not read.
 */
function mediaList(cell: string): Array<string> | null {
  const found = new Set<string>()
  for (const [, inside = ''] of cell.matchAll(/\(([^)]*)\)/g)) {
    const words = inside.toLowerCase().match(/[a-z]+/g) ?? []
    if (words.some((word) => word in MEDIA)) return null
  }
  const items = cell
    .replace(/\([^)]*\)/g, '')
    .split(/,|\band\b/i)
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item !== '')
  for (const item of items) {
    if (NOT_MEDIA.has(item)) continue
    const medium = MEDIA[item]
    if (!medium) return null
    found.add(medium)
  }
  return found.size > 0 ? MEDIA_ORDER.filter((m) => found.has(m)) : null
}

/**
 * A model page's `| Supported data types | **Inputs** … **Output** … |` row.
 * Null when the row is missing or either side names something that is not a
 * medium ("Text embeddings", "Video with audio"): a partial list would read
 * as the whole answer.
 */
export function parsePageModalities(
  markdown: string,
): { input: Array<string>; output: Array<string> } | null {
  const row = markdown.match(
    /^\| Supported data types \|\s*\*\*Inputs?\*\*(.*?)\*\*Outputs?\*\*(.*?)\|\s*$/m,
  )
  const input = mediaList(row?.[1] ?? '')
  const output = mediaList(row?.[2] ?? '')
  return input && output ? { input, output } : null
}

/** `Gemini 3.8 \& 3.7 Flash` → [`gemini-3.8-flash`, `gemini-3.7-flash`]. */
function familyIds(label: string): Array<string> {
  const clean = label
    .replace(/\*\*|\\/g, '')
    .replace(/^Gemini\s+/i, '')
    .trim()
  const match = clean.match(/^([\d.]+(?:\s*&\s*[\d.]+)*)\s+(.+)$/)
  const slug = (rest: string) => rest.toLowerCase().replace(/\s+/g, '-')
  if (!match?.[1] || !match[2]) return [`gemini-${slug(clean)}`]
  const tail = slug(match[2])
  return match[1].split('&').map((v) => `gemini-${v.trim()}-${tail}`)
}

const CANNOT_DISABLE =
  /cannot (be )?disable|cannot be turned off|do not support full thinking-off/i

/**
 * Families the thinking page says cannot turn thinking fully off.
 * `flashLite` is the bare "Flash-Lite" mention, which covers every
 * flash-lite column. A versioned "Gemini 3.1 Flash-Lite" is one exact id.
 */
function mandatoryEffortFamilies(markdown: string): {
  exact: Set<string>
  flashLite: boolean
} {
  const exact = new Set<string>()
  let flashLite = false
  for (const para of markdown.split(/\n\s*\n/)) {
    for (const sentence of para.split(/(?<=[.!?])\s+/)) {
      if (!CANNOT_DISABLE.test(sentence)) continue
      if (
        /flash-lite/i.test(sentence) &&
        !/Gemini\s+\d+(?:\.\d+)*\s+Flash-Lite/i.test(sentence)
      ) {
        flashLite = true
      }
      for (const match of sentence.matchAll(
        /Gemini\s+(\d+(?:\.\d+)*)\s+([A-Za-z][\w-]*)/g,
      )) {
        const version = match[1]
        const tail = (match[2] ?? '').toLowerCase()
        if (version && tail) exact.add(`gemini-${version}-${tail}`)
      }
    }
  }
  return { exact, flashLite }
}

function effortMandatory(
  id: string,
  named: { exact: Set<string>; flashLite: boolean },
): boolean | null {
  if (named.exact.has(id)) return true
  if (named.flashLite && id.endsWith('-flash-lite')) return true
  return null
}

/** Family id → reasoning, from both thinking tables. */
export function parseThinkingPage(
  markdown: string,
): Map<string, ModelReasoning> {
  const out = new Map<string, ModelReasoning>()
  const named = mandatoryEffortFamilies(markdown)
  const rows = markdownTableRows(markdown)
  const levelHeader = rows.find((row) => row[0] === 'Thinking Level')
  if (levelHeader) {
    const levelRows = rows.filter((row) =>
      /^\*\*`[a-z]+`\*\*$/.test(row[0] ?? ''),
    )
    levelHeader.forEach((label, col) => {
      if (col === 0 || label === 'Description') return
      const efforts = levelRows
        .filter((row) => /^supported/i.test(row[col] ?? ''))
        .map((row) => (row[0] ?? '').replace(/[*`]/g, ''))
      if (efforts.length === 0) return
      for (const id of familyIds(label)) {
        out.set(id, {
          mode: 'effort',
          mandatory: effortMandatory(id, named),
          efforts,
        })
      }
    })
  }
  for (const [model = '', , range, disable] of rows) {
    if (!/^\*\*[\d.]+ /.test(model) || !range?.includes('`')) continue
    for (const id of budgetIds(model)) {
      out.set(id, { mode: 'budget', mandatory: /^N\/A/.test(disable ?? '') })
    }
  }
  return out
}

/** `thinkingBudget = -1` from a budget-table cell, or null. */
function budgetNumber(cell: string | undefined): number | null {
  const match = cell?.match(/thinkingBudget\s*=\s*(-?\d+)/)
  if (!match?.[1]) return null
  const value = Number(match[1])
  return Number.isInteger(value) ? value : null
}

export interface GeminiBudgetBody {
  /** Dynamic-thinking cell. Gemini publishes -1, not an effort name. */
  on: number
  /** Disable cell, when it publishes a `thinkingBudget` number. */
  off: number | null
}

/**
 * Budget-table model cell → API ids. The native-audio row says
 * "Flash Live Native Audio" and dates the snapshot in parentheses; the
 * API id drops "Live" and keeps that date only.
 */
export function budgetIds(modelCell: string): Array<string> {
  const plain = modelCell.replace(/\*\*/g, '').trim()
  const dated = plain.match(/^(.*?)\s*\((\d{2}-\d{4})\)$/)
  const name = (dated?.[1] ?? plain).trim()
  const date = dated?.[2]
  const native = name.match(/^([\d.]+)\s+Flash Live Native Audio Preview$/i)
  if (native) {
    return native[1] && date
      ? [`gemini-${native[1]}-flash-native-audio-preview-${date}`]
      : []
  }
  return familyIds(modelCell.replace(/\s*\([^)]*\)/, ''))
}

/** Family id → dynamic and disable `thinkingBudget` numbers. */
export function parseThinkingBudgets(
  markdown: string,
): Map<string, GeminiBudgetBody> {
  const out = new Map<string, GeminiBudgetBody>()
  for (const row of markdownTableRows(markdown)) {
    const [model = '', , range, disable, dynamic] = row
    if (!/^\*\*[\d.]+ /.test(model) || !range?.includes('`')) continue
    const on = budgetNumber(dynamic)
    if (on === null) continue
    for (const id of budgetIds(model)) {
      out.set(id, { on, off: budgetNumber(disable) })
    }
  }
  return out
}

const EFFORT_WORDS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * Backtick thinking levels on a model page. Quoted samples do not count.
 * Two paragraphs that list different levels return null. `mandatory` is
 * true only when the paragraph that lists the levels says thinking cannot
 * be turned off.
 */
export function parsePageThinking(markdown: string): ModelReasoning | null {
  const sets: Array<Array<string>> = []
  let mandatory: boolean | null = null
  for (const para of markdown.split(/\n\s*\n/)) {
    if (!/thinking[_\s-]?levels?/i.test(para)) continue
    const unsupported = new Set<string>()
    for (const match of para.matchAll(
      /\b(minimal|low|medium|high|xhigh|max)\b[^.]{0,80}?not supported/gi,
    )) {
      unsupported.add((match[1] ?? '').toLowerCase())
    }
    const efforts: Array<string> = []
    for (const match of para.matchAll(/`([^`]+)`/g)) {
      const word = (match[1] ?? '').trim().toLowerCase()
      if (!EFFORT_WORDS.includes(word) || unsupported.has(word)) continue
      if (!efforts.includes(word)) efforts.push(word)
    }
    if (efforts.length === 0) continue
    sets.push(efforts)
    if (CANNOT_DISABLE.test(para)) mandatory = true
  }
  const efforts = sets[0]
  if (!efforts) return null
  if (sets.some((set) => set.join() !== efforts.join())) return null
  return { mode: 'effort', mandatory, efforts }
}

const MODEL_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/

function backtickIds(line: string): Array<string> {
  const chunks: Array<string> = []
  const stripped = line.replace(/```([^`]*)```/g, (_match, body: string) => {
    chunks.push(body)
    return ' '
  })
  for (const match of stripped.matchAll(/`([^`]+)`/g)) {
    chunks.push(match[1] ?? '')
  }
  const ids: Array<string> = []
  for (const chunk of chunks) {
    for (const token of chunk.split(/\s+/)) {
      if (MODEL_ID.test(token)) ids.push(token)
    }
  }
  return ids
}

export interface GeminiIndexDoc {
  url: string
  ids: Array<string>
}

function cleanDocUrl(raw: string): string {
  return raw.replace(/\.md\.txt$/, '').replace(/[),.;]+$/, '')
}

/** Models index: each docs URL, plus endpoint ids from table rows only. */
export function parseModelIndexDocs(markdown: string): Array<GeminiIndexDoc> {
  const byUrl = new Map<string, Set<string>>()
  for (const line of markdown.split('\n')) {
    const urls = [
      ...line.matchAll(
        /https:\/\/ai\.google\.dev\/gemini-api\/docs\/[a-z0-9./_-]+/g,
      ),
    ]
    if (urls.length === 0) continue
    const ids = line.startsWith('|') ? backtickIds(line) : []
    for (const match of urls) {
      const url = cleanDocUrl(match[0])
      const set = byUrl.get(url) ?? new Set<string>()
      for (const id of ids) set.add(id)
      byUrl.set(url, set)
    }
  }
  return [...byUrl].map(([url, ids]) => ({ url, ids: [...ids] }))
}

function modelSlug(url: string): string | null {
  return url.match(/\/models\/([a-z0-9.-]+?)(?:\.md\.txt)?$/)?.[1] ?? null
}

export function parseModelIndex(markdown: string): Array<string> {
  return [
    ...new Set(
      parseModelIndexDocs(markdown).flatMap((doc) => {
        const slug = modelSlug(doc.url)
        return slug ? [slug] : []
      }),
    ),
  ]
}

export interface GeminiPageSection {
  /** Model-code, agent-code, then version ids, in that order. */
  ids: Array<string>
  codes: Array<string>
  versions: Array<string>
  modalities: { input: Array<string>; output: Array<string> } | null
  tools: Array<string>
}

function labeledIds(chunk: string, label: string): Array<string> {
  const ids: Array<string> = []
  for (const line of chunk.split('\n')) {
    if (!line.startsWith(`| ${label} |`)) continue
    ids.push(...backtickIds(line))
  }
  return [...new Set(ids)]
}

function sectionFrom(chunk: string): GeminiPageSection {
  const codes = [
    ...new Set([
      ...labeledIds(chunk, 'Model code'),
      ...labeledIds(chunk, 'Agent code'),
    ]),
  ]
  const versions = labeledIds(chunk, 'Versions').filter(
    (id) => !codes.includes(id),
  )
  return {
    ids: [...codes, ...versions],
    codes,
    versions,
    modalities: parsePageModalities(chunk),
    tools: parsePageTools(chunk),
  }
}

/**
 * One section per model-code heading. A page with no model code stays one
 * anonymous section, so a property table with no heading still parses.
 * Preamble in front of the first model code is dropped.
 */
export function parsePageSections(markdown: string): Array<GeminiPageSection> {
  const chunks = markdown
    .split(/^(?=#{2,3} )/m)
    .filter((chunk) => /^#{2,3} /.test(chunk))
  const sections = (chunks.length > 0 ? chunks : [markdown]).map(sectionFrom)
  const named = sections.filter((section) => section.ids.length > 0)
  if (named.length > 0) return named
  const modalities = parsePageModalities(markdown)
  const tools = parsePageTools(markdown)
  return modalities || tools.length > 0
    ? [{ ids: [], codes: [], versions: [], modalities, tools }]
    : []
}

/** Longest family `rawId` is, or extends with a version suffix. */
export function familyOf(
  rawId: string,
  families: Iterable<string>,
): string | null {
  let best: string | null = null
  for (const family of families) {
    const exact = rawId === family
    const extends_ =
      rawId.startsWith(`${family}-`) &&
      /^(preview|latest|exp|\d)/.test(rawId.slice(family.length + 1))
    if ((exact || extends_) && (!best || family.length > best.length)) {
      best = family
    }
  }
  return best
}

type GeminiFeatures = Pick<ModelInfo, 'absent'> & {
  reasoning: ModelReasoning | null
  budget: GeminiBudgetBody | null
  serverTools: Array<string> | null
  modalities: { input: Array<string>; output: Array<string> } | null
  factSources: ModelFactSources
}

interface LoadedPage {
  url: string
  sections: Array<GeminiPageSection>
  reasoning: ModelReasoning | null
  hash: string
}

interface BoundSection {
  modalities: GeminiPageSection['modalities']
  tools: Array<string>
  reasoning: ModelReasoning | null
  sourceUrl: string
  hash: string
}

function pageUrl(url: string): string {
  return `${url.replace(/\.md\.txt$/, '')}.md.txt`
}

function docMatches(rawId: string, doc: GeminiIndexDoc): boolean {
  if (doc.ids.includes(rawId)) return true
  const slug = modelSlug(doc.url)
  return slug !== null && familyOf(rawId, [slug]) === slug
}

/**
 * Reasoning, server tools and modalities per listed id, with provenance.
 * A model page that fails to load is that family's alone: its rows keep the
 * stored tools and modalities (`absent`) and the failure is in
 * `docsFailures`. Reasoning the thinking table does not name is kept the
 * same way, so a stored page-derived object survives a blip.
 */
export async function geminiModelFeatures(
  rawIds: Array<string>,
  kv?: KVNamespace,
): Promise<{
  features: (rawId: string, thinking: boolean) => GeminiFeatures
  docsFailures: DocsFailures
}> {
  const [index, thinking] = await Promise.all([
    cachedDocs(kv, GEMINI_MODELS_INDEX_URL, async () => {
      const markdown = await fetchText(GEMINI_MODELS_INDEX_URL)
      const parsed = parseModelIndexDocs(markdown)
      if (!parsed.some((doc) => modelSlug(doc.url))) {
        throw new Error('gemini models index: 0 slugs')
      }
      return parsed
    }),
    cachedDocs(kv, GEMINI_THINKING_URL, async () => {
      const markdown = await fetchText(GEMINI_THINKING_URL)
      const parsed = parseThinkingPage(markdown)
      assertParsed(parsed, 'gemini thinking page')
      return {
        reasoning: Object.fromEntries(parsed),
        budgets: Object.fromEntries(parseThinkingBudgets(markdown)),
        hash: await sha256Text(markdown),
      }
    }),
  ])
  const slugs = index.flatMap((doc) => {
    const slug = modelSlug(doc.url)
    return slug ? [slug] : []
  })
  const needed = index.filter((doc) => rawIds.some((id) => docMatches(id, doc)))
  const run = docsRun()
  const pages = await mapConcurrent(needed, 8, (doc) => {
    const url = pageUrl(doc.url)
    return tryDocs(run, url, (cached) =>
      cached(kv, url, async () => {
        const markdown = await fetchText(url)
        const sections = parsePageSections(markdown)
        const named = sections.filter((section) => section.ids.length > 0)
        return {
          url,
          sections,
          reasoning: named.length <= 1 ? parsePageThinking(markdown) : null,
          hash: await sha256Text(markdown),
        }
      }),
    )
  })
  const loaded = pages.flatMap((page) => (page ? [page] : []))
  // Every page read and none states modalities is a reshaped site, not a
  // catalog without media. Throwing keeps the stored column.
  if (
    loaded.length > 0 &&
    !loaded.some((page) => page.sections.some((section) => section.modalities))
  ) {
    throw new Error(
      `gemini model pages: 0 of ${String(loaded.length)} state modalities`,
    )
  }
  const byId = new Map<string, BoundSection>()
  const bySlug = new Map<string, BoundSection>()
  const loadedUrls = new Set(loaded.map((page) => page.url))
  const placements = loaded.flatMap((page) =>
    pagePlacements(page, index, bySlug),
  )
  for (const kind of ['code', 'version', 'index'] as const) {
    for (const place of placements) {
      if (place.kind !== kind) continue
      const prev = byId.get(place.id)
      byId.set(
        place.id,
        prev ? chooseBound(place.id, prev, place.bound, kind) : place.bound,
      )
    }
  }
  const lookup = (rawId: string): BoundSection | undefined => {
    const exact = byId.get(rawId)
    if (exact) return exact
    const fromId = familyOf(rawId, byId.keys())
    if (fromId) {
      const bound = byId.get(fromId)
      if (bound) return bound
    }
    const slug = familyOf(rawId, slugs)
    return slug ? bySlug.get(slug) : undefined
  }
  const features = (rawId: string, modelThinks: boolean): GeminiFeatures => {
    const factSources: ModelFactSources = {}
    const budgetId = familyOf(rawId, Object.keys(thinking.budgets))
    const budget = budgetId ? (thinking.budgets[budgetId] ?? null) : null
    const family = modelThinks
      ? familyOf(rawId, Object.keys(thinking.reasoning))
      : null
    let reasoning = family ? (thinking.reasoning[family] ?? null) : null
    if (reasoning && family) {
      factSources.reasoning = {
        derivation: 'docs-derived',
        sourceUrl: GEMINI_THINKING_URL,
        sourceHash: thinking.hash,
        path: family,
      }
    }
    const failed = index
      .filter((doc) => docMatches(rawId, doc))
      .some((doc) => !loadedUrls.has(pageUrl(doc.url)))
    if (failed) {
      const absentFacts: Array<ModelFact> = ['serverTools', 'modalities']
      if (modelThinks && !reasoning) absentFacts.push('reasoning')
      return {
        reasoning,
        budget,
        serverTools: null,
        modalities: null,
        factSources,
        ...unavailable(...absentFacts),
      }
    }
    const bound = lookup(rawId)
    if (!reasoning && modelThinks && !family && bound?.reasoning) {
      reasoning = bound.reasoning
      factSources.reasoning = {
        derivation: 'docs-derived',
        sourceUrl: bound.sourceUrl,
        sourceHash: bound.hash,
        path: 'thinking level',
      }
    } else if (modelThinks && !reasoning) {
      factSources.reasoning = {
        derivation: 'docs-derived',
        sourceUrl: GEMINI_THINKING_URL,
        sourceHash: thinking.hash,
        path: 'silent',
      }
    }
    if (!bound) {
      return {
        reasoning,
        budget,
        serverTools: null,
        modalities: null,
        factSources,
      }
    }
    const source = (path: string): FactSource => ({
      derivation: 'docs-derived',
      sourceUrl: bound.sourceUrl,
      sourceHash: bound.hash,
      path,
    })
    if (bound.modalities) {
      factSources.modalities = source('Supported data types')
    }
    if (bound.tools.length > 0) {
      factSources.serverTools = Object.fromEntries(
        bound.tools.map((tool) => [tool, source('Capabilities')]),
      )
    }
    return {
      reasoning,
      budget,
      serverTools: bound.tools.length > 0 ? bound.tools : null,
      modalities: bound.modalities,
      factSources,
    }
  }
  return { features, docsFailures: docsReport(run) }
}

interface Placement {
  id: string
  kind: 'code' | 'version' | 'index'
  bound: BoundSection
}

/**
 * A dedicated `/models/{id}` page wins over another page that repeats the
 * id. Two model codes and no dedicated page is a real conflict. A version
 * row repeating an id keeps the earlier page.
 */
function chooseBound(
  id: string,
  prev: BoundSection,
  next: BoundSection,
  kind: Placement['kind'],
): BoundSection {
  if (prev.sourceUrl === next.sourceUrl) return prev
  const prevExact = modelSlug(prev.sourceUrl) === id
  const nextExact = modelSlug(next.sourceUrl) === id
  if (nextExact && !prevExact) return next
  if (prevExact && !nextExact) return prev
  if (kind === 'code') {
    throw new Error(`gemini model pages: ${id} is documented twice`)
  }
  return prev
}

function pagePlacements(
  page: LoadedPage,
  index: Array<GeminiIndexDoc>,
  bySlug: Map<string, BoundSection>,
): Array<Placement> {
  const named = page.sections.filter((section) => section.ids.length > 0)
  const doc = index.find((item) => pageUrl(item.url) === page.url)
  const slug = modelSlug(page.url)
  const out: Array<Placement> = []
  const add = (
    ids: Array<string>,
    kind: Placement['kind'],
    bound: BoundSection,
  ) => {
    for (const id of ids) out.push({ id, kind, bound })
  }
  if (named.length === 1 && named[0]) {
    const bound: BoundSection = {
      modalities: named[0].modalities,
      tools: named[0].tools,
      reasoning: page.reasoning,
      sourceUrl: page.url,
      hash: page.hash,
    }
    add(named[0].codes, 'code', bound)
    add(named[0].versions, 'version', bound)
    if (slug) bySlug.set(slug, bound)
    add(
      (doc?.ids ?? []).filter((id) => !named[0]?.ids.includes(id)),
      'index',
      bound,
    )
    return out
  }
  if (named.length === 0 && page.sections[0]) {
    const bound: BoundSection = {
      modalities: page.sections[0].modalities,
      tools: page.sections[0].tools,
      reasoning: page.reasoning,
      sourceUrl: page.url,
      hash: page.hash,
    }
    if (slug) bySlug.set(slug, bound)
    add(doc?.ids ?? [], 'index', bound)
    return out
  }
  for (const section of named) {
    const bound: BoundSection = {
      modalities: section.modalities,
      tools: section.tools,
      reasoning: null,
      sourceUrl: page.url,
      hash: page.hash,
    }
    add(section.codes, 'code', bound)
    add(section.versions, 'version', bound)
  }
  return out
}
