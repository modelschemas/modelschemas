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
 * see `parseByteplusVideo` and `parseByteplusImages`. A page missing chat,
 * video, or image rows throws. Seedance estimates also read frame rate and
 * output sizes from the video generation tutorial; if that page fails, the
 * cards publish without an estimate rather than failing the lookup.
 */
import { compileTokenCard, compileUnitCard } from '@modelschemas/rate-card'
import type {
  Expr,
  RateCard,
  RateCardEstimate,
  TokenRateTier,
} from '@modelschemas/rate-card'

import { errorMessage } from '#/server/errors.ts'

import { tagDocsFacts } from './fact-sources.ts'
import { assertParsed, cachedDocs } from './model-facts.ts'
import { fetchText, sha256Text } from './types.ts'
import type { ModelInfo } from './types.ts'

export const BYTEPLUS_PRICING_URL =
  'https://docs.byteplus.com/en/docs/ModelArk/1544106'

/** Seedance output sizes and frame rates (the token formula's inputs). */
export const BYTEPLUS_VIDEO_GUIDE_URL =
  'https://docs.byteplus.com/en/docs/modelark/video-generation-tutorial'

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
 * Catalog id → page row. Exact id wins. Otherwise the undated page id the
 * catalog id extends with a `-YYMMDD` date — never another suffix, so
 * `seedance-1-0-pro-fast-…` cannot take an undated `seedance-1-0-pro` row.
 */
export function byteplusRatesFor<T>(
  rawId: string,
  rates: Map<string, T>,
): T | undefined {
  const exact = rates.get(rawId)
  if (exact) return exact
  const dated = rawId.match(/^(.+)-\d{6}$/)?.[1]
  return dated === undefined ? undefined : rates.get(dated)
}

/**
 * Seedance rates, USD per million tokens: service tier (`default` online,
 * `flex` offline) → resolution (`*` when the row names none) → variant. A
 * variant is `no_video`/`video` (does the input carry a video),
 * `silent`/`audio` (`generate_audio`), or `all` when the model has one
 * rate.
 */
export type ByteplusVideoRates = Record<
  string,
  Record<string, Record<string, number>>
>

const VIDEO_VARIANTS: Array<[RegExp, string]> = [
  [/Input without video: (\d+(?:\.\d+)?)/i, 'no_video'],
  [/Input with video: (\d+(?:\.\d+)?)/i, 'video'],
  [/Video with audio: (\d+(?:\.\d+)?)/i, 'audio'],
  [/Video without audio: (\d+(?:\.\d+)?)/i, 'silent'],
]

/** A plain positive decimal, or `null`. */
function decimal(text: string): number | null {
  const value = /^\d+(?:\.\d+)?$/.test(text) ? Number(text) : NaN
  return Number.isFinite(value) && value > 0 ? value : null
}

/** Both halves of a split, or one flat rate — anything else refuses. */
function variantRates(body: string): Record<string, number> | null {
  const text = body.trim()
  const flat = decimal(text)
  if (flat !== null) return { all: flat }
  if (/^[\d.]+$/.test(text)) return null
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
 * (the discount is enterprise-only and time-boxed). Promo text with no
 * "(Original)" price beside it may be quoting the discounted rate, so it
 * refuses.
 */
function videoCell(
  cell: string,
): Record<string, Record<string, number>> | null | undefined {
  const promos = cell.match(/Time limited \d+% off/gi)?.length ?? 0
  const originals = cell.match(/\(Original\)/gi)?.length ?? 0
  if (promos !== originals) return null
  const text = cell
    .replace(/\(Original\)/gi, '')
    .replace(/Time limited \d+% off/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (/^not supported/i.test(text)) return undefined
  // [lead, "480p and 720p", body, "1080p", body, …]
  const parts = text.split(/For ([^:]+?) outputs?:/i)
  const lead = parts[0]?.trim() ?? ''
  // A rate with no "For … outputs" applies whatever the resolution.
  if (lead && parts.length > 1) return null
  const segments: Array<[Array<string>, string]> = lead ? [[['*'], lead]] : []
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
 * is the id. A model with any unreadable cell gets no rates (and a warning).
 * Only the first matching table is read.
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
  const [table] = tables
  if (!table) return out
  const at = (key: string) => table.keys.indexOf(key)
  for (const row of table.rows) {
    const id = (row[at('model id')] ?? '').split(' ')[0] ?? ''
    if (!/^[a-z0-9-]+$/.test(id)) continue
    const online = videoCell(row[at('online inference')] ?? '')
    const offline = videoCell(row[at('offline inference')] ?? '')
    if (!online || offline === null) {
      warnUnread('video', id, row)
      continue
    }
    out.set(id, { default: online, ...(offline && { flex: offline }) })
  }
  return out
}

/**
 * Image table: `Model ID ‖ Input image price ‖ Output image price`, USD per
 * image. Only flat rows with free input images are read here; Seedream 5.0
 * pro's pixel-tiered row is `parseByteplusPixelTiers`. Only the first
 * matching table is read.
 */
export function parseByteplusImages(doc: ByteplusDoc): Map<string, number> {
  const out = new Map<string, number>()
  const tables = tablesWith(doc, [
    'model id',
    'input image price',
    'output image price',
  ])
  const [table] = tables
  if (!table) return out
  const at = (key: string) => table.keys.indexOf(key)
  for (const row of table.rows) {
    const id = (row[at('model id')] ?? '').split(' ')[0] ?? ''
    if (!/^[a-z0-9-]+$/.test(id)) continue
    const input = (row[at('input image price')] ?? '').trim()
    const output = decimal((row[at('output image price')] ?? '').trim())
    if (!/^free$/i.test(input) || output === null) {
      // Pixel-tiered rows belong to `parseByteplusPixelTiers`.
      const tiered = pixelTierRates(input, row[at('output image price')] ?? '')
      if (!tiered) warnUnread('image', id, row)
      continue
    }
    out.set(id, output)
  }
  return out
}

/** A priced row this parser could not read: logged so drift is visible. */
function warnUnread(table: string, id: string, row: Array<string>): void {
  console.warn(
    JSON.stringify({
      job: 'byteplus-pricing',
      skipped: id,
      table,
      cells: row,
    }),
  )
}

/**
 * Output frame rate and pixel size per Seedance model, from the video
 * generation tutorial. The page's token formula is
 * `(input s + output s) × width × height × fps / 1024`; cards apply it to
 * output seconds only, since a request with input video refuses the
 * estimate (see `compileSeedanceCard`).
 */
export interface SeedanceGeometry {
  fps: number
  /** resolution → ratio → output pixels */
  dims: Record<string, Record<string, { w: number; h: number }>>
}

/**
 * A resolution cell's note, for one display name: `true` serves it,
 * `false` does not, `null` is a note this parser cannot read. Known
 * shapes: "X and Y do not support 1080p", "Only X supports 4K".
 */
function noteServes(note: string, name: string): boolean | null {
  if (note === '') return true
  const names = (list: string) =>
    list.split(/,\s*|\s+and\s+/i).map((part) => part.trim().toLowerCase())
  const excluded = note.match(/^(.+?) (?:do|does) not support\b/i)?.[1]
  if (excluded) return !names(excluded).includes(name)
  const only = note.match(/^Only (.+?) supports?\b/i)?.[1]
  if (only) return names(only).includes(name)
  return null
}

/**
 * Two tables on the tutorial: the model table (`Model name` header row of
 * display names, a `Model ID` row, a `Frame rate` row) and the pixel table
 * (`Resolution ‖ Aspect ratio ‖ <model or "… series">…`). A pixel column
 * names one display name, or a series every display name it prefixes; a
 * model's own column beats its series. A resolution note ("… do not support
 * 1080p") limits who gets that row, and a note it cannot read drops the row.
 * Two columns of the same rank disagreeing on a size drops the model, as
 * does a repeated display name. Models missing a fact get no geometry.
 */
export function parseSeedanceGeometry(
  doc: ByteplusDoc,
): Map<string, SeedanceGeometry> {
  const out = new Map<string, SeedanceGeometry>()
  const [models] = tablesWith(doc, ['model name'])
  const [pixels] = tablesWith(doc, ['resolution', 'aspect ratio'])
  if (!models || !pixels) return out
  const row = (label: string) =>
    models.rows.find((r) => r.some((c) => c.toLowerCase() === label))
  const ids = row('model id')
  const fpsRow = row('frame rate')
  if (!ids || !fpsRow) return out

  // Display name (lowercase) → model id and fps.
  const byName = new Map<string, { id: string; fps: number }>()
  const repeated = new Set<string>()
  models.keys.forEach((name, column) => {
    const id = ids[column] ?? ''
    const fps = fpsRow[column]?.match(/^(\d+) fps$/i)?.[1]
    if (!/^[a-z0-9-]+$/.test(id) || !fps) return
    if (byName.has(name)) repeated.add(name)
    byName.set(name, { id, fps: Number(fps) })
  })
  for (const name of repeated) byName.delete(name)

  const at = (key: string) => pixels.keys.indexOf(key)
  // id|resolution|ratio → rank of the column that set it (2 own, 1 series).
  const rank = new Map<string, number>()
  const conflicted = new Set<string>()
  let resolution = ''
  let note = ''
  for (const cells of pixels.rows) {
    const label = (cells[at('resolution')] ?? '').trim()
    if (label) {
      const [first = '', ...rest] = label.split(' ')
      resolution = first.toLowerCase()
      note = rest.join(' ')
    }
    const ratio = cells[at('aspect ratio')] ?? ''
    if (!/^(\d+p|4k)$/.test(resolution) || !/^\d+:\d+$/.test(ratio)) continue
    pixels.keys.forEach((column, index) => {
      const size = cells[index]?.match(/^(\d+)×(\d+)$/)
      if (!size) return
      const series = column.replace(/ series$/, '')
      for (const [name, model] of byName) {
        const own = name === column
        const inSeries =
          series !== column &&
          (name === series || name.startsWith(`${series} `))
        if (!own && !inSeries) continue
        if (noteServes(note, name) !== true) continue
        const key = `${model.id}|${resolution}|${ratio}`
        const level = own ? 2 : 1
        const geometry = out.get(model.id) ?? { fps: model.fps, dims: {} }
        const byRatio = (geometry.dims[resolution] ??= {})
        const size2 = { w: Number(size[1]), h: Number(size[2]) }
        const prior = rank.get(key) ?? 0
        if (prior > level) continue
        const held = byRatio[ratio]
        if (
          prior === level &&
          held &&
          (held.w !== size2.w || held.h !== size2.h)
        ) {
          conflicted.add(model.id)
        }
        byRatio[ratio] = size2
        rank.set(key, level)
        out.set(model.id, geometry)
      }
    })
  }
  for (const id of conflicted) out.delete(id)
  return out
}

/** Seedream 5.0 pro: per-image output rates split at a pixel count. */
export interface ByteplusPixelTiers {
  /** USD per input image after the first (the first is free). */
  extraInput: number
  /** Tier boundary in pixels; at or below it is `low`. */
  maxLowPixels: number
  /** The largest `size` level the page puts in the low tier (`1.5K`). */
  lowLevel: string
  low: number
  high: number
}

const PIXEL_TIER_INPUT = /^First image: Free From the 2nd image: ([\d.]+)$/i
// Layer decomposition is not read: the page says one request's layers can
// land in different tiers, so the card refuses that mode.
const PIXEL_TIER_OUTPUT =
  /^Single image generation: ≤ ([\d.]+) million pixels \(([\d.]+)K or lower\): ([\d.]+) > \1 million pixels \(higher than \2K\): ([\d.]+) Layer decomposition: /i

/** One image-table row as pixel tiers, or null for any other wording. */
function pixelTierRates(
  input: string,
  output: string,
): ByteplusPixelTiers | null {
  const inMatch = PIXEL_TIER_INPUT.exec(input)
  const outMatch = PIXEL_TIER_OUTPUT.exec(output)
  if (!inMatch || !outMatch) return null
  const extraInput = decimal(inMatch[1] ?? '')
  const millions = decimal(outMatch[1] ?? '')
  const low = decimal(outMatch[3] ?? '')
  const high = decimal(outMatch[4] ?? '')
  if (extraInput === null || millions === null || low === null) return null
  if (high === null) return null
  const lowLevel = `${outMatch[2]}K`
  return { extraInput, maxLowPixels: millions * 1e6, lowLevel, low, high }
}

/** The image table's pixel-tiered rows; only the first table is read. */
export function parseByteplusPixelTiers(
  doc: ByteplusDoc,
): Map<string, ByteplusPixelTiers> {
  const out = new Map<string, ByteplusPixelTiers>()
  const [table] = tablesWith(doc, [
    'model id',
    'input image price',
    'output image price',
  ])
  if (!table) return out
  const at = (key: string) => table.keys.indexOf(key)
  for (const row of table.rows) {
    const id = (row[at('model id')] ?? '').split(' ')[0] ?? ''
    const rates = pixelTierRates(
      row[at('input image price')] ?? '',
      row[at('output image price')] ?? '',
    )
    if (/^[a-z0-9-]+$/.test(id) && rates) out.set(id, rates)
  }
  return out
}

/**
 * Ark's `size` levels for Seedream 5.0 pro image generation (Image
 * generation API, docs.byteplus.com/en/docs/ModelArk/1541523; default
 * `2K`). The model picks the pixels, but every size that API doc lists for
 * a level sits on one side of 2.61 MP, as the pricing page's "(1.5K or
 * lower)" says. `4K` and `auto` are not image-generation sizes.
 */
const SEEDREAM_PRO_LEVELS = ['1K', '1.5K', '2K']

/**
 * `usage.generated_images × tier rate + max(0, usage.input_images − 1) ×
 * input fee`.
 * `size` is a level (tier from the page's "(1.5K or lower)") or `WxH`
 * (tier from its pixel count). `layer_decomposition: true` refuses: its
 * layers are billed per layer at each one's own tier, which no request
 * field fixes.
 */
export function compileSeedreamProCard(
  rates: ByteplusPixelTiers,
  source: RateCard['source'],
): RateCard | null {
  const levelNumber = (level: string) => Number(level.replace(/K$/, ''))
  const boundary = levelNumber(rates.lowLevel)
  if (!SEEDREAM_PRO_LEVELS.includes(rates.lowLevel)) return null
  const levelTier: Array<Expr> = SEEDREAM_PRO_LEVELS.flatMap((level) => [
    { '==': [{ var: 'size.level' }, level] },
    levelNumber(level) <= boundary ? 'low' : 'high',
  ])
  const pixels = { '*': [{ var: 'size.width' }, { var: 'size.height' }] }
  const tier: Expr = {
    if: [
      { missing: 'size.level' },
      { if: [{ '<=': [pixels, rates.maxLowPixels] }, 'low', 'high'] },
      { if: levelTier },
    ],
  }
  const mode: Expr = {
    if: [{ var: 'layer_decomposition' }, 'layer_decomposition', 'generation'],
  }
  return {
    inputs: {
      size: {
        param: 'size',
        kind: 'dimensions',
        levels: SEEDREAM_PRO_LEVELS,
        default: '2K',
      },
      layer_decomposition: {
        param: 'layer_decomposition',
        kind: 'boolean',
        default: false,
      },
      // Ark's own count of the request's images: `image` is a string or a
      // list, and the bill counts what Ark received. Live 2026-10-02: no
      // image → 0, a string → 1, a list of 3 → 3.
      input_images: { param: 'input_images', bound: 'usage', kind: 'number' },
      generated_images: {
        param: 'generated_images',
        bound: 'usage',
        kind: 'number',
      },
    },
    tables: { output: { generation: { low: rates.low, high: rates.high } } },
    price: {
      '+': [
        {
          '*': [
            { var: 'generated_images' },
            { lookup: { table: 'output', keys: [mode, tier] } },
          ],
        },
        {
          '*': [
            { max: [0, { '-': [{ var: 'input_images' }, 1] }] },
            rates.extraInput,
          ],
        },
      ],
    },
    examples: [],
    source,
  }
}

/**
 * `rate × usage.completion_tokens / 1e6`. The page bills "Token unit price ×
 * Token consumption" and says consumption is what `usage.completion_tokens`
 * returns, so that is the price as billed.
 *
 * With `geometry`, an omitted `completion_tokens` is estimated by the
 * page's own formula over the tutorial's published sizes, and the estimate
 * endpoint labels it as such. The estimate refuses where the published
 * method does not hold: video input (a minimum-token floor applies, in a
 * table the cron cannot read), draft renders, `ratio: adaptive`, and any
 * resolution × ratio the tutorial does not list.
 *
 * Draft refuses outright on resolution-priced models: the page bills a draft
 * at a different resolution than the request names. Video input is not a
 * request field Ark exposes as one value (it rides in `content`), so the
 * caller states it as `usage.input_video`. Only models whose rates split on
 * video input take it (the tutorial lists no video reference for 1.x), so
 * the others' estimate has no video input to refuse.
 */
export function compileSeedanceCard(
  rates: ByteplusVideoRates,
  source: RateCard['source'],
  geometry?: { model: SeedanceGeometry; url: string; hash: string },
): RateCard | null {
  const online = rates.default
  if (!online) return null
  const resolutions = Object.keys(online)
  const variants = Object.keys(online[resolutions[0] ?? ''] ?? {})
  // Every tier prices the same resolutions, each with the same variants.
  const shape = (tier: Record<string, Record<string, number>>) =>
    Object.keys(tier).sort().join() === [...resolutions].sort().join() &&
    Object.values(tier).every(
      (v) => Object.keys(v).sort().join() === [...variants].sort().join(),
    )
  if (!Object.values(rates).every(shape)) return null

  const inputs: RateCard['inputs'] = {
    // Ark's own defaults: omitted means online inference, not a draft.
    service_tier: {
      param: 'service_tier',
      kind: 'enum',
      values: Object.keys(rates),
      default: 'default',
    },
    draft: { param: 'draft', kind: 'boolean', default: false },
    completion_tokens: {
      param: 'completion_tokens',
      bound: 'usage',
      kind: 'number',
    },
  }
  let resolution: Expr = '*'
  if (!resolutions.includes('*')) {
    inputs.resolution = {
      param: 'resolution',
      kind: 'enum',
      values: resolutions,
    }
    resolution = { if: [{ var: 'draft' }, 'draft', { var: 'resolution' }] }
  }
  let variant: Expr = 'all'
  let inputVideo: Expr = 'no_input_video'
  if (variants.includes('video')) {
    inputs.input_video = {
      param: 'input_video',
      bound: 'usage',
      kind: 'boolean',
    }
    variant = { if: [{ var: 'input_video' }, 'video', 'no_video'] }
    inputVideo = {
      if: [{ var: 'input_video' }, 'input_video', 'no_input_video'],
    }
  } else if (variants.includes('audio')) {
    inputs.generate_audio = { param: 'generate_audio', kind: 'boolean' }
    variant = { if: [{ var: 'generate_audio' }, 'audio', 'silent'] }
  }

  const tables: RateCard['tables'] = { rate: rates }
  if (geometry && inputs.completion_tokens?.kind === 'number') {
    // A series column also lists resolutions a member does not serve
    // ("2.0 Fast and Mini do not support 1080p"); the rate table is the
    // model's own list.
    const dims = inputs.resolution
      ? Object.fromEntries(
          Object.entries(geometry.model.dims).filter(([r]) =>
            resolutions.includes(r),
          ),
        )
      : geometry.model.dims
    const ratios = [...new Set(Object.values(dims).flatMap(Object.keys))]
    const estimateInputs: RateCardEstimate['inputs'] = {
      ratio: { param: 'ratio', kind: 'enum', values: ratios },
      duration: { param: 'duration', kind: 'number' },
    }
    if (!inputs.resolution) {
      estimateInputs.resolution = {
        param: 'resolution',
        kind: 'enum',
        values: Object.keys(dims),
      }
    }
    const side = (key: 'w' | 'h'): Expr => ({
      lookup: {
        table: 'pixels',
        keys: [{ var: 'resolution' }, { var: 'ratio' }, key],
      },
    })
    tables.pixels = dims
    // Shapes the published method covers; any other key refuses.
    tables.estimate_supported = { no_input_video: { not_draft: 1 } }
    inputs.completion_tokens.estimate = {
      inputs: estimateInputs,
      value: {
        '*': [
          {
            lookup: {
              table: 'estimate_supported',
              keys: [
                inputVideo,
                { if: [{ var: 'draft' }, 'draft', 'not_draft'] },
              ],
            },
          },
          {
            '/': [
              {
                '*': [
                  { var: 'duration' },
                  side('w'),
                  side('h'),
                  geometry.model.fps,
                ],
              },
              1024,
            ],
          },
        ],
      },
      source: { url: geometry.url, hash: geometry.hash },
    }
  }
  return {
    inputs,
    tables,
    price: {
      '/': [
        {
          '*': [
            {
              lookup: {
                table: 'rate',
                keys: [{ var: 'service_tier' }, resolution, variant],
              },
            },
            { var: 'completion_tokens' },
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
export function pricingContent(
  html: string,
  label = 'byteplus pricing page',
): string {
  const at = html.indexOf('window._ROUTER_DATA')
  const start = html.indexOf('{', at)
  const end = html.indexOf('</script>', start)
  if (at < 0 || start < 0 || end < 0) {
    throw new Error(`${label}: no _ROUTER_DATA`)
  }
  const router = JSON.parse(html.slice(start, end)) as {
    loaderData?: Record<string, { curDoc?: { Content?: string } } | null>
  }
  const content = Object.values(router.loaderData ?? {}).find(
    (entry) => typeof entry?.curDoc?.Content === 'string',
  )?.curDoc?.Content
  if (!content) throw new Error(`${label}: no curDoc.Content`)
  return content
}

type PricedFacts = Pick<ModelInfo, 'pricing' | 'factSources'>

interface CachedPricing {
  rates: Record<string, ByteplusChatRates>
  video: Record<string, ByteplusVideoRates>
  images: Record<string, number>
  // Absent on entries cached before #102.
  pixelTiers?: Record<string, ByteplusPixelTiers>
  hash: string
  extractedAt: string
}

interface CachedGuide {
  geometry: Record<string, SeedanceGeometry>
  hash: string
}

/**
 * Tutorial geometry, or none: it only feeds the labelled estimate, so a
 * failed fetch or parse publishes billed-only cards rather than failing
 * every BytePlus price with it.
 */
async function seedanceGuide(kv?: KVNamespace): Promise<CachedGuide | null> {
  const label = 'byteplus video generation tutorial'
  try {
    return await cachedDocs<CachedGuide>(
      kv,
      BYTEPLUS_VIDEO_GUIDE_URL,
      async () => {
        const content = pricingContent(
          await fetchText(BYTEPLUS_VIDEO_GUIDE_URL),
          label,
        )
        const parsed = parseSeedanceGeometry(JSON.parse(content) as ByteplusDoc)
        assertParsed(parsed, label)
        return {
          geometry: Object.fromEntries(parsed),
          hash: await sha256Text(content),
        }
      },
    )
  } catch (error) {
    console.warn(
      JSON.stringify({
        job: 'byteplus-pricing',
        skipped: 'seedance estimates',
        error: errorMessage(error),
      }),
    )
    return null
  }
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
      const pixelTiers = parseByteplusPixelTiers(page)
      assertParsed(parsed, 'byteplus pricing page')
      assertParsed(video, 'byteplus pricing page (video)')
      assertParsed(images, 'byteplus pricing page (images)')
      return {
        rates: Object.fromEntries(parsed),
        video: Object.fromEntries(video),
        images: Object.fromEntries(images),
        pixelTiers: Object.fromEntries(pixelTiers),
        hash: await sha256Text(content),
        extractedAt: new Date().toISOString(),
      }
    },
  )
  const guide = await seedanceGuide(kv)
  const geometry = new Map(Object.entries(guide?.geometry ?? {}))
  const rates = new Map(Object.entries(doc.rates))
  const video = new Map(Object.entries(doc.video))
  const images = new Map(Object.entries(doc.images))
  const pixelTiers = new Map(Object.entries(doc.pixelTiers ?? {}))
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
    if (seedance) {
      const model = byteplusRatesFor(rawId, geometry)
      return compileSeedanceCard(
        seedance,
        source,
        model && guide
          ? { model, url: BYTEPLUS_VIDEO_GUIDE_URL, hash: guide.hash }
          : undefined,
      )
    }
    const tiered = byteplusRatesFor(rawId, pixelTiers)
    if (tiered) return compileSeedreamProCard(tiered, source)
    const perImage = byteplusRatesFor(rawId, images)
    if (perImage === undefined) return null
    // Billed per image returned (usage.generated_images); group-image mode
    // returns a variable count, so the caller supplies it.
    return compileUnitCard(
      {
        quantity: { param: 'generated_images', bound: 'usage' },
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
