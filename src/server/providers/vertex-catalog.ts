/**
 * Gemini Enterprise Agent Platform catalog (issue #203).
 *
 * `publishers.models.list` needs a service account. The locations page
 * names the Google model ids that are served, and each model's card
 * states limits, modalities, tools, and versions. The thinking page
 * names `thinking_level` or `thinking_budget`. Partner models and Chirp
 * are not this provider.
 */
import type { Activity } from '#/db/schema.ts'

import { tagDocsFacts } from './fact-sources.ts'
import {
  assertParsed,
  cachedDocs,
  mapConcurrent,
  parseDay,
  tokenCount,
} from './model-facts.ts'
import { fetchText } from './types.ts'
import type { ModelInfo, ModelReasoning } from './types.ts'
import { normModelName } from './vertex-text.ts'
import { vertexModelPricing } from './vertex-pricing.ts'

export const VERTEX_LOCATIONS_URL =
  'https://docs.cloud.google.com/gemini-enterprise-agent-platform/resources/locations'
export const VERTEX_THINKING_URL =
  'https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/thinking'
const DOCS = 'https://docs.cloud.google.com'

const MODEL_ID = /^[a-z0-9][a-z0-9._-]*$/

const ENDPOINT =
  'v1/projects/{projectsId}/locations/{locationsId}/publishers/{publishersId}/models/{modelsId}'

export interface LocationModel {
  rawId: string
  cardPath: string | null
}

export interface CardVersion {
  rawId: string
  releasedAt: number | null
  deprecated: boolean
}

export interface VertexCard {
  title: string
  modelId: string | null
  versions: Array<CardVersion>
  contextWindow: number | null
  maxOutput: number | null
  modalities: { input: Array<string>; output: Array<string> } | null
  capabilities: Array<string>
  serverTools: Array<string>
  /** `null` when the card has no Thinking row. */
  thinkingSupported: boolean | null
}

export interface VertexThinking {
  /** Normed card title → thinking_level values. */
  effort: Map<string, Array<string>>
  /** Normed card title → whether thinking can be turned off. */
  budgetOff: Set<string>
  budgetOn: Set<string>
}

function linesOf(html: string): Array<string> {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;/g, "'")
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

function isModelId(id: string): boolean {
  return (
    MODEL_ID.test(id) &&
    /^(gemini|veo|imagen|lyria|virtual-try-on|text-embedding|text-multilingual-embedding|multimodalembedding)/.test(
      id,
    ) &&
    !id.startsWith('chirp')
  )
}

function codeIds(raw: string): Array<string> {
  const text = raw.replace(/<[^>]+>/g, '')
  const quoted = [...text.matchAll(/'([a-z0-9][a-z0-9._-]*)'/g)].map(
    (match) => match[1] ?? '',
  )
  if (quoted.length > 0) return quoted.filter((id) => id.length > 0)
  const bare = text.replace(/[()[\]]/g, '').trim()
  return bare ? [bare] : []
}

/** Google model ids in `#google-models`, each tied to the card linked above it. */
export function parseLocationModels(html: string): Array<LocationModel> {
  const start = html.indexOf('<h2 id="google-models"')
  const end = html.indexOf('<h2 id="genai-partner-models"')
  if (start < 0 || end < start) return []
  const section = html.slice(start, end)
  const found = new Map<string, string | null>()
  let card: string | null = null
  const re =
    /href="(\/gemini-enterprise-agent-platform\/models\/(?:gemini|veo|vto)\/[^"#?]+)"|<code[^>]*>([\s\S]*?)<\/code>/g
  for (const match of section.matchAll(re)) {
    if (match[1]) {
      card = match[1]
      continue
    }
    for (const rawId of codeIds(match[2] ?? '')) {
      if (!isModelId(rawId)) continue
      const prior = found.get(rawId)
      if (prior === undefined) found.set(rawId, card)
      else if (prior === null && card) found.set(rawId, card)
    }
    card = null
  }
  return [...found].map(([rawId, cardPath]) => ({ rawId, cardPath }))
}

function sliceBetween(
  lines: Array<string>,
  start: string,
  ends: Array<string>,
  accept: (slice: Array<string>) => boolean,
): Array<string> {
  for (let index = 0; index < lines.length; index++) {
    if (lines[index] !== start) continue
    const end = lines.findIndex((line, at) => at > index && ends.includes(line))
    const slice = lines.slice(index + 1, end < 0 ? index + 48 : end)
    if (accept(slice)) return slice
  }
  return []
}

const MODALITY = new Set(['text', 'image', 'audio', 'video'])

function modalitiesOf(lines: Array<string>): VertexCard['modalities'] {
  const slice = sliceBetween(
    lines,
    'Modalities',
    ['Token limits', 'Capabilities'],
    (part) => part.some((line) => /input|output|not supported/i.test(line)),
  )
  const input: Array<string> = []
  const output: Array<string> = []
  for (let index = 0; index < slice.length; index++) {
    const name = slice[index]?.toLowerCase()
    if (!name || !MODALITY.has(name)) continue
    const direction = slice
      .slice(index + 1, index + 4)
      .find((line) =>
        /input and output|input only|output only|not supported/i.test(line),
      )
    if (!direction || /not supported/i.test(direction)) continue
    if (/input/i.test(direction)) input.push(name)
    if (/output/i.test(direction)) output.push(name)
  }
  if (input.length === 0 && output.length === 0) return null
  return { input, output }
}

const SERVER_TOOLS: Record<string, string> = {
  'code execution': 'codeExecution',
  'url context': 'urlContext',
  'computer use': 'computerUse',
}

function labelBefore(
  slice: Array<string>,
  index: number,
): { label: string; detail: string } {
  const collected: Array<string> = []
  for (let at = index - 1; at >= 0 && collected.length < 2; at--) {
    const line = slice[at] ?? ''
    if (/^preview( feature)?$/i.test(line)) continue
    collected.push(line)
  }
  const [nearest, prior] = collected
  if (nearest?.includes(',') && prior) return { label: prior, detail: nearest }
  return { label: nearest ?? '', detail: '' }
}

function flagsIn(slice: Array<string>): {
  capabilities: Array<string>
  serverTools: Array<string>
  thinkingSupported: boolean | null
} {
  const capabilities: Array<string> = []
  const serverTools: Array<string> = []
  let thinkingSupported: boolean | null = null
  for (let index = 0; index < slice.length; index++) {
    const line = slice[index] ?? ''
    if (!/^supported$/i.test(line) && !/^not supported$/i.test(line)) continue
    const supported = /^supported$/i.test(line)
    const { label, detail } = labelBefore(slice, index)
    const name = label.toLowerCase()
    if (name === 'thinking') thinkingSupported = supported
    if (supported && name === 'structured output') {
      capabilities.push('structured_outputs')
    }
    if (supported && name === 'function calling') capabilities.push('tools')
    if (supported && name === 'grounding' && /google search/i.test(detail)) {
      serverTools.push('googleSearch')
    }
    const tool = SERVER_TOOLS[name]
    if (supported && tool) serverTools.push(tool)
  }
  const order = ['googleSearch', 'codeExecution', 'urlContext', 'computerUse']
  return {
    capabilities,
    serverTools: order.filter((tool) => serverTools.includes(tool)),
    thinkingSupported,
  }
}

function versionsOf(lines: Array<string>): Array<CardVersion> {
  const start = lines.findIndex(
    (line, index) =>
      line === 'Versions' &&
      isModelId((lines[index + 1] ?? '').replace(/\*$/, '')),
  )
  if (start < 0) return []
  const versions: Array<CardVersion> = []
  let current: CardVersion | null = null
  for (const line of lines.slice(start + 1)) {
    if (
      /^send feedback$|^except as otherwise noted$|^last updated\b/i.test(line)
    ) {
      break
    }
    const id = line.replace(/\*$/, '')
    if (isModelId(id)) {
      current = { rawId: id, releasedAt: null, deprecated: false }
      versions.push(current)
      continue
    }
    if (!current) continue
    if (/^launch stage:/i.test(line) && /deprecated|retired/i.test(line)) {
      current.deprecated = true
    }
    const released = /^release date:\s*(.+)$/i.exec(line)?.[1]
    if (released) {
      const day = parseDay(released)
      if (day !== null) current.releasedAt = day / 1000
    }
  }
  return versions
}

/** The model name is the text before the docs-site bookmark widget. */
function pageTitle(html: string): string {
  const inner = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? ''
  const heading = inner.split(/<devsite-/i)[0] ?? ''
  return heading
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function parseCard(html: string): VertexCard {
  const lines = linesOf(html)
  const title = pageTitle(html)
  const modelIdLine = lines.findIndex(
    (line, index) =>
      line === 'Model ID' &&
      isModelId(lines[index + 1]?.replace(/\*$/, '') ?? ''),
  )
  const modelId =
    modelIdLine < 0
      ? null
      : (lines[modelIdLine + 1]?.replace(/\*$/, '') ?? null)
  const contextAt = lines.indexOf('Context window')
  const outputAt = lines.indexOf('Maximum output tokens')
  const capabilitySlice = [
    ...sliceBetween(
      lines,
      'Capabilities',
      ['Tools', 'Consumption options', 'Technical specifications'],
      (part) =>
        part.some(
          (line) => /^supported$/i.test(line) || /^not supported$/i.test(line),
        ),
    ),
    ...sliceBetween(
      lines,
      'Tools',
      ['Consumption options', 'Technical specifications'],
      (part) =>
        part.some(
          (line) => /^supported$/i.test(line) || /^not supported$/i.test(line),
        ),
    ),
  ]
  const flags = flagsIn(capabilitySlice)
  const capabilities = [...flags.capabilities]
  if (lines.some((line) => /^Temperature:/i.test(line))) {
    capabilities.push('temperature')
  }
  if (lines.some((line) => /^topP:/i.test(line))) capabilities.push('top_p')
  if (lines.some((line) => /^topK:/i.test(line))) capabilities.push('top_k')
  return {
    title,
    modelId,
    versions: versionsOf(lines),
    contextWindow: contextAt < 0 ? null : tokenCount(lines[contextAt + 1]),
    maxOutput: outputAt < 0 ? null : tokenCount(lines[outputAt + 1]),
    modalities: modalitiesOf(lines),
    capabilities,
    serverTools: flags.serverTools,
    thinkingSupported: flags.thinkingSupported,
  }
}

function namesIn(sentence: string): Array<string> {
  return sentence.split(/\s+and\s+|,\s*/).flatMap((part) => {
    const name =
      /^(Gemini\s+\d+(?:\.\d+)?(?:\s+(?:Flash-Lite|Flash|Pro|Lite|Image|Live|Cyber|Omni|TTS|preview)){0,4})/i.exec(
        part.trim(),
      )
    return name?.[1] ? [normModelName(name[1])] : []
  })
}

function tableRows(table: string): Array<Array<string>> {
  return [...table.matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((row) =>
    [...row[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(
      (cell) =>
        cell[1]
          ?.replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim() ?? '',
    ),
  )
}

/** Effort levels and which 2.5 models can set thinking_budget to 0. */
export function parseThinking(html: string): VertexThinking {
  const effort = new Map<string, Array<string>>()
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, ' ')
  const budgetOff = new Set(
    namesIn(
      /can turn off thinking for (.+?)(?:\.(?!\d)|$)/i.exec(text)?.[1] ?? '',
    ),
  )
  const budgetOn = new Set(
    namesIn(
      /(?:can't|cannot) turn off thinking for (.+?)(?:\.(?!\d)|$)/i.exec(
        text,
      )?.[1] ?? '',
    ),
  )
  for (const match of html.matchAll(/<table[\s\S]*?<\/table>/gi)) {
    const rows = tableRows(match[0])
    const header = rows[0]?.join(' ').toLowerCase() ?? ''
    if (header.includes('thinking_level')) {
      for (const row of rows.slice(1)) {
        const name = row[0]
        if (!name || /^model$/i.test(name)) continue
        const efforts = row
          .slice(1)
          .join(' ')
          .split(/[^A-Za-z]+/)
          .map((token) => token.toUpperCase())
          .filter((token) =>
            ['MINIMAL', 'LOW', 'MEDIUM', 'HIGH'].includes(token),
          )
        const unique = [...new Set(efforts)]
        if (unique.length === 0) continue
        effort.set(normModelName(name), unique)
      }
    }
  }
  return { effort, budgetOff, budgetOn }
}

export function vertexActivity(rawId: string): Activity {
  if (rawId.startsWith('veo-')) return 'video'
  if (
    rawId.includes('embedding') ||
    rawId.startsWith('text-embedding') ||
    rawId.startsWith('text-multilingual-embedding') ||
    rawId.startsWith('multimodalembedding')
  ) {
    return 'embeddings'
  }
  if (
    rawId.includes('image') ||
    rawId.startsWith('virtual-try-on') ||
    rawId.startsWith('imagen')
  ) {
    return 'image'
  }
  if (
    /(?:^|-)tts(?:-|$)/.test(rawId) ||
    rawId.includes('transcribe') ||
    rawId.includes('live-translate')
  ) {
    return 'audio'
  }
  return 'chat'
}

export function vertexEndpoint(rawId: string): string {
  const activity = vertexActivity(rawId)
  if (activity === 'embeddings') return `${ENDPOINT}:embedContent`
  if (activity === 'video') return `${ENDPOINT}:predictLongRunning`
  if (rawId.startsWith('virtual-try-on') || rawId.startsWith('imagen')) {
    return `${ENDPOINT}:predict`
  }
  return `${ENDPOINT}:generateContent`
}

function reasoningFor(
  title: string,
  thinkingSupported: boolean | null,
  thinking: VertexThinking,
): ModelReasoning | null {
  if (thinkingSupported === false) return null
  const key = normModelName(title)
  const efforts = thinking.effort.get(key)
  if (efforts) return { mode: 'effort', mandatory: true, efforts }
  if (thinking.budgetOff.has(key) || thinking.budgetOn.has(key)) {
    return { mode: 'budget', mandatory: !thinking.budgetOff.has(key) }
  }
  return null
}

function cardUrl(path: string): string {
  return `${DOCS}${path}`
}

async function loadCards(
  paths: Array<string>,
  kv?: KVNamespace,
): Promise<Map<string, VertexCard>> {
  const cards = new Map<string, VertexCard>()
  await mapConcurrent(paths, 4, async (path) => {
    const card = await cachedDocs(kv, cardUrl(path), async () =>
      parseCard(await fetchText(cardUrl(path))),
    )
    cards.set(path, card)
  })
  return cards
}

/**
 * Served Google model ids, plus version ids published on those cards.
 * Prices come from the standard token table, joined by card title.
 */
export async function vertexModelList(
  kv?: KVNamespace,
): Promise<Array<ModelInfo>> {
  const locations = await cachedDocs(kv, VERTEX_LOCATIONS_URL, async () => {
    const models = parseLocationModels(await fetchText(VERTEX_LOCATIONS_URL))
    assertParsed(
      new Map(models.map((model) => [model.rawId, model])),
      'vertex locations',
    )
    return models
  })
  const paths = [
    ...new Set(
      locations.flatMap((model) => (model.cardPath ? [model.cardPath] : [])),
    ),
  ]
  const cards = await loadCards(paths, kv)
  const thinking = await cachedDocs(kv, VERTEX_THINKING_URL, async () => {
    const parsed = parseThinking(await fetchText(VERTEX_THINKING_URL))
    if (
      parsed.effort.size === 0 &&
      parsed.budgetOff.size + parsed.budgetOn.size === 0
    ) {
      throw new Error('vertex thinking page: parsed 0 model rows')
    }
    return {
      effort: Object.fromEntries(parsed.effort),
      budgetOff: [...parsed.budgetOff],
      budgetOn: [...parsed.budgetOn],
    }
  })
  const thinkingMaps: VertexThinking = {
    effort: new Map(Object.entries(thinking.effort)),
    budgetOff: new Set(thinking.budgetOff),
    budgetOn: new Set(thinking.budgetOn),
  }
  const pricing = await vertexModelPricing(kv)

  const rows = new Map<
    string,
    { card: VertexCard | null; cardPath: string | null }
  >()
  for (const location of locations) {
    rows.set(location.rawId, {
      card: location.cardPath ? (cards.get(location.cardPath) ?? null) : null,
      cardPath: location.cardPath,
    })
  }
  for (const [path, card] of cards) {
    const ids = [
      ...card.versions.map((version) => version.rawId),
      ...(card.modelId ? [card.modelId] : []),
    ]
    for (const rawId of ids) {
      if (!rows.has(rawId)) rows.set(rawId, { card, cardPath: path })
      else if (!rows.get(rawId)?.card) rows.set(rawId, { card, cardPath: path })
    }
  }

  return [...rows].map(([rawId, row]) => {
    const card = row.card
    const version = card?.versions.find((item) => item.rawId === rawId) ?? null
    const activity = vertexActivity(rawId)
    const reasoning = card
      ? reasoningFor(card.title, card.thinkingSupported, thinkingMaps)
      : null
    const capabilities = card
      ? [
          ...card.capabilities,
          ...(reasoning || card.thinkingSupported ? ['reasoning'] : []),
        ].filter((flag, index, all) => all.indexOf(flag) === index)
      : null
    const priced = card ? pricing(card.title) : {}
    const facts = {
      contextWindow: card?.contextWindow ?? null,
      maxOutput: card?.maxOutput ?? null,
      modalities: card?.modalities ?? null,
      capabilities,
      reasoning,
      serverTools:
        card && card.serverTools.length > 0 ? card.serverTools : null,
    }
    const sourceUrl = row.cardPath
      ? cardUrl(row.cardPath)
      : VERTEX_LOCATIONS_URL
    return {
      rawId,
      displayName: card?.title || null,
      activity,
      schemaEndpointId: vertexEndpoint(rawId),
      contextWindow: facts.contextWindow,
      maxOutput: facts.maxOutput,
      modalities: facts.modalities,
      capabilities:
        capabilities && capabilities.length > 0 ? capabilities : null,
      reasoning,
      serverTools: facts.serverTools,
      releasedAt: version?.releasedAt ?? null,
      deprecated: version?.deprecated ?? false,
      pricing: priced.pricing ?? null,
      factSources: {
        ...tagDocsFacts(facts, sourceUrl),
        ...priced.factSources,
      },
    }
  })
}
