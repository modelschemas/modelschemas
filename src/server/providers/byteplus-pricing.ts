/**
 * BytePlus chat prices from the ModelArk pricing page (issue #73). The page
 * is a Lark document: `window._ROUTER_DATA` embeds `curDoc.Content`, and
 * each table is an `aceTable` of a row zone plus a column zone. Cell text
 * lives in a zone id `x{rowId}x{colId}`.
 *
 * Only the standard online-inference table is read (the one that quotes
 * cache storage per hour). Flex and batch tables further down are half of
 * standard and are not levers. Cache storage itself is per token-hour, not
 * per request, so that column is ignored. A peak/off-peak row has no lever
 * for time of day, so that model gets no card. A dated catalog id uses an
 * undated page row only when exactly one page id is its prefix
 * (`dola-seed-2-1-turbo` → `dola-seed-2-1-turbo-260628`).
 *
 * Video (Seedance) and image (Seedream) tables are read too (issue #99):
 * see `parseByteplusVideo` and `parseByteplusImages`. A page that yields no
 * chat, video, or image row throws.
 */
import { compileTokenCard, compileUnitCard } from '@modelschemas/rate-card'
import type { Expr, RateCard, TokenRateTier } from '@modelschemas/rate-card'

import { tagDocsFacts } from './fact-sources.ts'
import { assertParsed, cachedDocs } from './model-facts.ts'
import { fetchText, sha256Text } from './types.ts'
import type { ModelInfo } from './types.ts'

export const BYTEPLUS_PRICING_URL =
  'https://docs.byteplus.com/en/docs/ModelArk/1544106'

/** Header (unit stripped) → request lever. Cache storage is not one. */
const LEVERS: Record<string, string> = {
  'input (non-audio)': 'input_tokens',
  'input (audio)': 'audio_tokens',
  'cache-hit input (non-audio)': 'cache_read_tokens',
  'cache-hit input (audio)': 'audio_cache_tokens',
  output: 'output_tokens',
}

interface DocOp {
  insert: string | { id?: string }
  attributes?: { aceTable?: string; [key: string]: unknown }
}

interface DocZone {
  ops?: Array<DocOp>
  zoneType?: string
  zoneId?: string
}

export interface ByteplusDoc {
  data: Record<string, DocZone>
}

export interface ByteplusChatRates {
  base: Record<string, number>
  tiers: Array<TokenRateTier>
}

function zoneText(zone: DocZone | undefined): string {
  return (zone?.ops ?? [])
    .map((op) => (typeof op.insert === 'string' ? op.insert : ''))
    .join('')
    .split('\n')
    .map((line) => line.replace(/^\*\s?/, '').trim())
    .filter((line) => line !== '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function headerKey(cell: string): string {
  return (
    cell
      .toLowerCase()
      // Drop the trailing unit ("(USD/M tokens)"), keep "(non-audio)".
      .replace(/\s*\([^)]*\)\s*$/, '')
      .replace(/\s+/g, ' ')
      .trim()
  )
}

/**
 * `Prompt length [0, 128]` is the base. `(128, 256]` starts above 128K
 * tokens. `-` is an untiered base row. Anything else (peak hours) refuses.
 */
function promptFloorK(label: string): number | null {
  if (label === '-' || label === '') return 0
  if (/^prompt length \[0,\s*[\d.]+\]$/i.test(label)) return 0
  const next = label.match(/^prompt length \(([\d.]+),\s*[\d.]+\]$/i)
  if (next?.[1]) return Number(next[1])
  return null
}

/** USD per million tokens. `undefined` is a lever the cell does not price. */
function usdPerMillion(cell: string): number | null | undefined {
  if (cell === '-' || cell === '') return undefined
  if (!/^[\d]+(?:\.[\d]+)?$/.test(cell)) return null
  return Number(cell) / 1e6
}

function tableRows(
  doc: ByteplusDoc,
  spec: string,
): Array<Array<string>> | null {
  const [rowId, colId] = spec.split(' ')
  const row = rowId ? doc.data[rowId] : undefined
  const col = colId ? doc.data[colId] : undefined
  if (!row || !col) return null
  const cols = (col.ops ?? []).flatMap((op) =>
    typeof op.insert === 'object' && op.insert.id ? [op.insert.id] : [],
  )
  return (row.ops ?? []).flatMap((op) => {
    const rowCell = op.insert
    if (typeof rowCell !== 'object' || !rowCell.id) return []
    const cellId = rowCell.id
    return [cols.map((column) => zoneText(doc.data[`x${cellId}x${column}`]))]
  })
}

function ratesFromGroup(
  rows: Array<Array<string>>,
  columns: { tier: number; levers: Record<string, number> },
): ByteplusChatRates | null {
  const base: Record<string, number> = {}
  const tiers: Array<TokenRateTier> = []
  for (const [index, row] of rows.entries()) {
    const floor = promptFloorK(row[columns.tier] ?? '')
    if (floor === null) return null
    const rates: Record<string, number> = {}
    for (const [key, lever] of Object.entries(LEVERS)) {
      const at = columns.levers[key]
      if (at === undefined) continue
      const value = usdPerMillion(row[at] ?? '')
      if (value === null) return null
      if (value !== undefined) rates[lever] = value
    }
    if (rates.input_tokens === undefined || rates.output_tokens === undefined) {
      return null
    }
    if (index === 0) {
      if (floor !== 0) return null
      Object.assign(base, rates)
      continue
    }
    if (floor <= 0) return null
    // Prompt length is the request's input. Audio columns are re-quoted in
    // the same bracket, so they count toward it when the card is compiled.
    tiers.push({ minPromptTokens: floor * 1000, rates })
  }
  return Object.keys(base).length > 0 ? { base, tiers } : null
}

/** Every table whose header (units stripped) names all of `required`. */
function tablesWith(
  doc: ByteplusDoc,
  required: Array<string>,
): Array<{ keys: Array<string>; rows: Array<Array<string>> }> {
  return (doc.data['0']?.ops ?? []).flatMap((op) => {
    const spec = op.attributes?.aceTable
    const rows = spec ? tableRows(doc, spec) : null
    const keys = rows?.[0]?.map(headerKey)
    if (!rows || !keys || !required.every((key) => keys.includes(key))) {
      return []
    }
    return [{ keys, rows: rows.slice(1) }]
  })
}

/** Page model id → standard online-inference rates. */
export function parseByteplusPricing(
  doc: ByteplusDoc,
): Map<string, ByteplusChatRates> {
  const out = new Map<string, ByteplusChatRates>()
  const tables = tablesWith(doc, [
    'model id',
    'cache-storage',
    'input (non-audio)',
    'output',
  ])
  for (const { keys, rows } of tables) {
    if (out.size > 0) break
    const tier = keys.indexOf('pricing tiers')
    const levers: Record<string, number> = {}
    for (const key of Object.keys(LEVERS)) {
      const at = keys.indexOf(key)
      if (at >= 0) levers[key] = at
    }
    if (tier < 0 || levers['input (non-audio)'] === undefined) continue
    let current: { id: string; rows: Array<Array<string>> } | null = null
    const groups: Array<{ id: string; rows: Array<Array<string>> }> = []
    for (const row of rows) {
      const id = row[keys.indexOf('model id')] ?? ''
      if (id !== '') {
        if (current) groups.push(current)
        current = { id, rows: [row] }
      } else if (current) {
        current.rows.push(row)
      }
    }
    if (current) groups.push(current)
    for (const group of groups) {
      if (out.has(group.id) || /\s/.test(group.id)) continue
      const rates = ratesFromGroup(group.rows, { tier, levers })
      if (rates) out.set(group.id, rates)
    }
  }
  return out
}

/**
 * Catalog id → page row. Exact id wins. Otherwise the single longest page
 * id that the catalog id extends with `-{suffix}`.
 */
export function byteplusRatesFor<T>(
  rawId: string,
  rates: Map<string, T>,
): T | undefined {
  const exact = rates.get(rawId)
  if (exact) return exact
  const prefixes = [...rates.keys()]
    .filter((key) => rawId.startsWith(`${key}-`))
    .sort((a, b) => b.length - a.length)
  const best = prefixes[0]
  if (!best || prefixes[1]?.length === best.length) return undefined
  return rates.get(best)
}

/**
 * Seedance rates, USD per million tokens: service tier (`default` online,
 * `flex` offline) → resolution → variant. A variant is `no_video`/`video`
 * (does the input carry a video), `silent`/`audio` (`generate_audio`), or
 * `all` when the model has one rate.
 */
export type ByteplusVideoRates = Record<
  string,
  Record<string, Record<string, number>>
>

const VIDEO_VARIANTS: Array<[RegExp, string]> = [
  [/Input without video: ([\d.]+)/i, 'no_video'],
  [/Input with video: ([\d.]+)/i, 'video'],
  [/Video with audio: ([\d.]+)/i, 'audio'],
  [/Video without audio: ([\d.]+)/i, 'silent'],
]

/** Rows that name no resolution (the 1.x models) price every 1.x tier. */
const ALL_RESOLUTIONS = ['480p', '720p', '1080p']

/** Both halves of a split, or one flat rate — anything else refuses. */
function variantRates(body: string): Record<string, number> | null {
  const text = body.trim()
  if (/^[\d.]+$/.test(text)) return { all: Number(text) }
  const rates: Record<string, number> = {}
  let rest = text
  for (const [pattern, variant] of VIDEO_VARIANTS) {
    rest = rest.replace(pattern, (_, n: string) => {
      rates[variant] = Number(n)
      return ''
    })
  }
  const pairs = [
    ['no_video', 'video'],
    ['silent', 'audio'],
  ]
  const paired = pairs.some(([a = '', b = '']) => {
    const keys = Object.keys(rates).sort()
    return keys.join() === [a, b].sort().join()
  })
  const usable = Object.values(rates).every((n) => Number.isFinite(n) && n > 0)
  return rest.trim() === '' && paired && usable ? rates : null
}

/**
 * One rate cell → resolution → variant. `undefined` is "Not supported yet";
 * `null` is a cell this parser cannot read. Promo cells quote the list
 * price as "(Original) 5.6 Time limited 25% off"; the list price is kept
 * (the discount is enterprise-only and time-boxed).
 */
function videoCell(
  cell: string,
): Record<string, Record<string, number>> | null | undefined {
  const text = cell
    .replace(/\(Original\)/gi, '')
    .replace(/Time limited \d+% off/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (/^not supported/i.test(text)) return undefined
  // [lead, "480p and 720p", body, "1080p", body, …]
  const parts = text.split(/For ([^:]+?) outputs?:/i)
  const lead = parts[0]?.trim() ?? ''
  const segments: Array<[Array<string>, string]> = lead
    ? [[ALL_RESOLUTIONS, lead]]
    : []
  for (let at = 1; at < parts.length; at += 2) {
    const named = parts[at]?.toLowerCase().match(/\d+p|4k/g) ?? []
    segments.push([named, parts[at + 1] ?? ''])
  }
  if (segments.length === 0) return null
  const out: Record<string, Record<string, number>> = {}
  for (const [resolutions, body] of segments) {
    const rates = variantRates(body)
    if (!rates || resolutions.length === 0) return null
    for (const resolution of resolutions) out[resolution] = rates
  }
  return out
}

/**
 * Video table: `Model ID ‖ Online inference ‖ Offline inference`. The id
 * cell trails a description ("… Pricing varies based on …"); its first word
 * is the id. A model with any unreadable cell gets no rates.
 */
export function parseByteplusVideo(
  doc: ByteplusDoc,
): Map<string, ByteplusVideoRates> {
  const out = new Map<string, ByteplusVideoRates>()
  const tables = tablesWith(doc, [
    'model id',
    'online inference',
    'offline inference',
  ])
  for (const { keys, rows } of tables) {
    const at = (key: string) => keys.indexOf(key)
    for (const row of rows) {
      const id = (row[at('model id')] ?? '').split(' ')[0] ?? ''
      const online = videoCell(row[at('online inference')] ?? '')
      const offline = videoCell(row[at('offline inference')] ?? '')
      if (!/^[a-z0-9-]+$/.test(id) || !online || offline === null) continue
      out.set(id, { default: online, ...(offline && { flex: offline }) })
    }
  }
  return out
}

/**
 * Image table: `Model ID ‖ Input image price ‖ Output image price`, USD per
 * image. Only flat rows with free input images are read; Seedream 5.0 pro
 * (pixel tiers, per-image input fee, layer decomposition) is left unpriced.
 */
export function parseByteplusImages(doc: ByteplusDoc): Map<string, number> {
  const out = new Map<string, number>()
  const tables = tablesWith(doc, [
    'model id',
    'input image price',
    'output image price',
  ])
  for (const { keys, rows } of tables) {
    for (const row of rows) {
      const id = (row[keys.indexOf('model id')] ?? '').split(' ')[0] ?? ''
      const input = row[keys.indexOf('input image price')] ?? ''
      const output = (row[keys.indexOf('output image price')] ?? '').trim()
      if (!/^[a-z0-9-]+$/.test(id) || !/^free$/i.test(input.trim())) continue
      if (!/^[\d.]+$/.test(output) || Number(output) <= 0) continue
      out.set(id, Number(output))
    }
  }
  return out
}

/**
 * Pixel area each resolution renders at — the page's token formula reads
 * only w × h. Seedance 1.0 publishes its own sizes (864×480, 1248×704,
 * 1920×1088 reproduce its usage table exactly); every later model's worked
 * examples reproduce at the plain 16:9 sizes. Ark sizes a resolution class
 * to the same area whatever the ratio, so 16:9 stands in for all of them.
 */
const SEEDANCE_DIMS: Record<string, { w: number; h: number }> = {
  '480p': { w: 854, h: 480 },
  '720p': { w: 1280, h: 720 },
  '1080p': { w: 1920, h: 1080 },
  '4k': { w: 3840, h: 2160 },
}
const SEEDANCE_1_0_DIMS: Record<string, { w: number; h: number }> = {
  '480p': { w: 864, h: 480 },
  '720p': { w: 1248, h: 704 },
  '1080p': { w: 1920, h: 1088 },
}

/**
 * `rate × tokens / 1e6`, where tokens are the caller's
 * `usage.completion_tokens` (what Ark bills) when given, else the page's
 * estimate `(input video s + output s) × w × h × 24 / 1024`. Draft renders
 * and the with-video minimum-token floor (a Lark base the cron cannot read)
 * are not modelled; supply `completion_tokens` for those.
 */
export function compileSeedanceCard(
  rawId: string,
  rates: ByteplusVideoRates,
  source: RateCard['source'],
): RateCard | null {
  const online = rates.default
  if (!online) return null
  const resolutions = Object.keys(online)
  const dims = rawId.startsWith('seedance-1-0')
    ? SEEDANCE_1_0_DIMS
    : SEEDANCE_DIMS
  if (resolutions.some((r) => !dims[r])) return null
  // Tiers must price the same resolutions with the same variants.
  const variants = Object.keys(online[resolutions[0] ?? ''] ?? {})
  const shapes = Object.values(rates).flatMap((tier) => Object.values(tier))
  if (
    shapes.some(
      (v) => Object.keys(v).sort().join() !== [...variants].sort().join(),
    )
  ) {
    return null
  }

  const inputs: RateCard['inputs'] = {
    resolution: {
      param: 'resolution',
      kind: 'enum',
      values: resolutions,
      default: resolutions.includes('720p') ? '720p' : resolutions[0],
    },
    duration: { param: 'duration', kind: 'number', default: 5 },
    service_tier: {
      param: 'service_tier',
      kind: 'enum',
      values: Object.keys(rates),
      default: 'default',
    },
    completion_tokens: {
      param: 'completion_tokens',
      bound: 'usage',
      kind: 'number',
      default: 0,
    },
  }
  let variant: Expr = 'all'
  if (variants.includes('video')) {
    inputs.input_video_duration = {
      param: 'input_video_duration',
      bound: 'usage',
      kind: 'number',
      default: 0,
    }
    variant = {
      if: [{ '>': [{ var: 'input_video_duration' }, 0] }, 'video', 'no_video'],
    }
  } else if (variants.includes('audio')) {
    inputs.generate_audio = {
      param: 'generate_audio',
      kind: 'boolean',
      default: false,
    }
    variant = { if: [{ var: 'generate_audio' }, 'audio', 'silent'] }
  }
  const side = (s: 'w' | 'h'): Expr => ({
    lookup: { table: 'dims', keys: [{ var: 'resolution' }, s] },
  })
  const seconds: Expr = variants.includes('video')
    ? { '+': [{ var: 'input_video_duration' }, { var: 'duration' }] }
    : { var: 'duration' }
  const estimate: Expr = {
    '/': [{ '*': [seconds, side('w'), side('h'), 24] }, 1024],
  }
  return {
    inputs,
    tables: {
      rate: rates,
      dims: Object.fromEntries(resolutions.map((r) => [r, dims[r] ?? {}])),
    },
    price: {
      '/': [
        {
          '*': [
            {
              lookup: {
                table: 'rate',
                keys: [{ var: 'service_tier' }, { var: 'resolution' }, variant],
              },
            },
            {
              if: [
                { '>': [{ var: 'completion_tokens' }, 0] },
                { var: 'completion_tokens' },
                estimate,
              ],
            },
          ],
        },
        1_000_000,
      ],
    },
    examples: [],
    source,
  }
}

/** Standard-table rates from the pricing page HTML. */
export function parseByteplusPricingPage(
  html: string,
): Map<string, ByteplusChatRates> {
  return parseByteplusPricing(JSON.parse(pricingContent(html)) as ByteplusDoc)
}

/**
 * `curDoc.Content` only. The page shell around it reshuffles between
 * fetches, so hashing the HTML would mark unchanged prices as new.
 */
export function pricingContent(html: string): string {
  const at = html.indexOf('window._ROUTER_DATA')
  const start = html.indexOf('{', at)
  const end = html.indexOf('</script>', start)
  if (at < 0 || start < 0 || end < 0) {
    throw new Error('byteplus pricing page: no _ROUTER_DATA')
  }
  const router = JSON.parse(html.slice(start, end)) as {
    loaderData?: Record<string, { curDoc?: { Content?: string } } | null>
  }
  const content = Object.values(router.loaderData ?? {}).find(
    (entry) => typeof entry?.curDoc?.Content === 'string',
  )?.curDoc?.Content
  if (!content) throw new Error('byteplus pricing page: no curDoc.Content')
  return content
}

type PricedFacts = Pick<ModelInfo, 'pricing' | 'factSources'>

interface CachedPricing {
  rates: Record<string, ByteplusChatRates>
  // Absent on entries cached before #99; they age out within the docs TTL.
  video?: Record<string, ByteplusVideoRates>
  images?: Record<string, number>
  hash: string
  extractedAt: string
}

/** Card lookup by catalog id. Ids no table prices get nothing. */
export async function byteplusModelPricing(
  kv?: KVNamespace,
): Promise<(rawId: string) => PricedFacts> {
  const doc = await cachedDocs<CachedPricing>(
    kv,
    BYTEPLUS_PRICING_URL,
    async () => {
      const html = await fetchText(BYTEPLUS_PRICING_URL)
      const content = pricingContent(html)
      const page = JSON.parse(content) as ByteplusDoc
      const parsed = parseByteplusPricing(page)
      const video = parseByteplusVideo(page)
      const images = parseByteplusImages(page)
      assertParsed(parsed, 'byteplus pricing page')
      assertParsed(video, 'byteplus pricing page (video)')
      assertParsed(images, 'byteplus pricing page (images)')
      return {
        rates: Object.fromEntries(parsed),
        video: Object.fromEntries(video),
        images: Object.fromEntries(images),
        hash: await sha256Text(content),
        extractedAt: new Date().toISOString(),
      }
    },
  )
  const rates = new Map(Object.entries(doc.rates))
  const video = new Map(Object.entries(doc.video ?? {}))
  const images = new Map(Object.entries(doc.images ?? {}))
  const source = {
    url: BYTEPLUS_PRICING_URL,
    hash: doc.hash,
    extractedAt: doc.extractedAt,
  }
  const card = (rawId: string): RateCard | null => {
    const chat = byteplusRatesFor(rawId, rates)
    if (chat) {
      return compileTokenCard(chat.base, chat.tiers, source, {
        extraPromptLevers: ['audio_tokens', 'audio_cache_tokens'],
      })
    }
    const seedance = byteplusRatesFor(rawId, video)
    if (seedance) return compileSeedanceCard(rawId, seedance, source)
    const perImage = byteplusRatesFor(rawId, images)
    if (perImage === undefined) return null
    // Group-image mode bills each image returned (usage.generated_images).
    return compileUnitCard(
      {
        quantity: { param: 'generated_images', bound: 'usage', default: 1 },
        rates: perImage,
      },
      source,
    )
  }
  return (rawId) => {
    const pricing = card(rawId)
    if (!pricing) return {}
    return {
      pricing,
      factSources: tagDocsFacts({ pricing }, BYTEPLUS_PRICING_URL, doc.hash),
    }
  }
}
