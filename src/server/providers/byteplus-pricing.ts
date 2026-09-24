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
 * Video and image tables bill by resolution and scenario, not by this token
 * sheet, and are left unpriced. A page that yields no chat row throws.
 */
import { compileTokenCard } from '@modelschemas/rate-card'
import type { TokenRateTier } from '@modelschemas/rate-card'

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
    tiers.push({ minPromptTokens: floor * 1000, rates })
  }
  return Object.keys(base).length > 0 ? { base, tiers } : null
}

/** Page model id → standard online-inference rates. */
export function parseByteplusPricing(
  doc: ByteplusDoc,
): Map<string, ByteplusChatRates> {
  const out = new Map<string, ByteplusChatRates>()
  for (const op of doc.data['0']?.ops ?? []) {
    const spec = op.attributes?.aceTable
    if (!spec || out.size > 0) continue
    const rows = tableRows(doc, spec)
    const header = rows?.[0]
    if (!rows || !header) continue
    const keys = header.map(headerKey)
    if (
      !keys.includes('model id') ||
      !keys.includes('cache-storage') ||
      !keys.includes('input (non-audio)') ||
      !keys.includes('output')
    ) {
      continue
    }
    const tier = keys.indexOf('pricing tiers')
    const levers: Record<string, number> = {}
    for (const key of Object.keys(LEVERS)) {
      const at = keys.indexOf(key)
      if (at >= 0) levers[key] = at
    }
    if (tier < 0 || levers['input (non-audio)'] === undefined) continue
    let current: { id: string; rows: Array<Array<string>> } | null = null
    const groups: Array<{ id: string; rows: Array<Array<string>> }> = []
    for (const row of rows.slice(1)) {
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
export function byteplusRatesFor(
  rawId: string,
  rates: Map<string, ByteplusChatRates>,
): ByteplusChatRates | undefined {
  const exact = rates.get(rawId)
  if (exact) return exact
  const prefixes = [...rates.keys()]
    .filter((key) => rawId.startsWith(`${key}-`))
    .sort((a, b) => b.length - a.length)
  const best = prefixes[0]
  if (!best || prefixes[1]?.length === best.length) return undefined
  return rates.get(best)
}

/** Standard-table rates from the pricing page HTML. */
export function parseByteplusPricingPage(
  html: string,
): Map<string, ByteplusChatRates> {
  return parseByteplusPricing(pricingDocument(html))
}

function pricingDocument(html: string): ByteplusDoc {
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
  return JSON.parse(content) as ByteplusDoc
}

type PricedFacts = Pick<ModelInfo, 'pricing' | 'factSources'>

/** Card lookup by catalog id. Ids the standard table does not price get nothing. */
export async function byteplusModelPricing(
  kv?: KVNamespace,
): Promise<(rawId: string) => PricedFacts> {
  const doc = await cachedDocs(kv, BYTEPLUS_PRICING_URL, async () => {
    const html = await fetchText(BYTEPLUS_PRICING_URL)
    const parsed = parseByteplusPricingPage(html)
    assertParsed(parsed, 'byteplus pricing page')
    return {
      rates: Object.fromEntries(parsed),
      hash: await sha256Text(html),
      extractedAt: new Date().toISOString(),
    }
  })
  const rates = new Map(Object.entries(doc.rates))
  return (rawId) => {
    const row = byteplusRatesFor(rawId, rates)
    const pricing = row
      ? compileTokenCard(row.base, row.tiers, {
          url: BYTEPLUS_PRICING_URL,
          hash: doc.hash,
          extractedAt: doc.extractedAt,
        })
      : null
    if (!pricing) return {}
    return {
      pricing,
      factSources: tagDocsFacts({ pricing }, BYTEPLUS_PRICING_URL, doc.hash),
    }
  }
}
