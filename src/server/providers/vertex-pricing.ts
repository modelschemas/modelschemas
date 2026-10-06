/**
 * Standard pay-as-you-go token prices from the Agent Platform pricing
 * page (issue #203). Priority, Flex, and Batch tables are other
 * products. A dated introductory row applies only while it is in
 * effect. Global wins when the same model lists both regions.
 * A row this parser does not understand drops that model rather than
 * quoting part of its bill. Per-count Veo and embedding tables do not
 * match the token header, so those models stay null.
 */
import { compileTokenCard } from '@modelschemas/rate-card'
import type { RateCard, TokenRateTier } from '@modelschemas/rate-card'

import { tagDocsFacts } from './fact-sources.ts'
import { assertParsed, cachedDocs, parseDay } from './model-facts.ts'
import { fetchText, sha256Text } from './types.ts'
import type { ModelInfo } from './types.ts'
import { htmlText, normModelName } from './vertex-text.ts'

export const VERTEX_PRICING_URL =
  'https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing'

const DAY_MS = 86_400_000
const LONG_CONTEXT = 200_000

export interface VertexRates {
  base: Record<string, number>
  tiers: Array<TokenRateTier>
  expiresAt?: string
}

interface Columns {
  model: number
  type: number
  region: number
  shortIn: number
  longIn: number
  shortCache: number
  longCache: number
}

interface PriceRow {
  type: string
  region: string
  prices: [number | null, number | null, number | null, number | null]
}

interface PriceGroup {
  rows: Array<PriceRow>
  expiresAt: string | null
}

function cells(row: string): Array<string> {
  return [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((match) =>
    htmlText(match[1] ?? ''),
  )
}

function columnsOf(header: Array<string>): Columns | null {
  const joined = header.join(' ').toLowerCase()
  if (/priority|flex|batch|codemender|alphaevolve/.test(joined)) return null
  if (!(/1m tokens|token price/.test(joined) && /200k/.test(joined)))
    return null
  const model = header.findIndex((cell) => /^model$/i.test(cell))
  const type = header.findIndex((cell) => /^type$/i.test(cell))
  const region = header.findIndex((cell) => /^region$/i.test(cell))
  let shortIn = -1
  let longIn = -1
  let shortCache = -1
  let longCache = -1
  header.forEach((cell, index) => {
    const text = cell.toLowerCase()
    if (!/200k/.test(text)) return
    const cached = /cach/.test(text)
    const greater = />/.test(text)
    if (cached && greater) longCache = index
    else if (cached) shortCache = index
    else if (greater) longIn = index
    else shortIn = index
  })
  if (model < 0 || type < 0 || shortIn < 0 || longIn < 0) return null
  return { model, type, region, shortIn, longIn, shortCache, longCache }
}

/** `null` is an unrecognised row. A priced unrecognised row refuses the model. */
export function priceLevers(type: string): Array<string> | null {
  const text = type.toLowerCase().replace(/\s+/g, ' ').trim()
  // "per picture" / "per second" is a different unit than the token columns.
  if (/\bper\b/.test(text) && !/\bper 1m\b/.test(text)) return null
  if (/^input(?::| \()/.test(text) && /\btext\b/.test(text)) {
    return ['input_tokens']
  }
  if (/^input: audio\b|^audio input\b|^input \(audio\)$/.test(text)) {
    return ['audio_tokens']
  }
  if (/^input: video, image\b/.test(text))
    return ['image_tokens', 'video_tokens']
  if (/^input: image\b|^image input\b/.test(text)) return ['image_tokens']
  if (/^input: video\b|^video input\b/.test(text)) return ['video_tokens']
  if (/^text output\b|^output: text\b/.test(text)) return ['output_tokens']
  if (/^image output\b|^output: image\b/.test(text)) {
    return ['image_output_tokens']
  }
  if (/^audio output\b|^output: audio\b/.test(text)) {
    return ['audio_output_tokens']
  }
  if (/^output: video\b|^video output\b/.test(text)) {
    return ['video_output_tokens']
  }
  return null
}

const CACHE_LEVER: Record<string, string> = {
  input_tokens: 'cache_read_tokens',
  audio_tokens: 'audio_cache_tokens',
  image_tokens: 'image_cache_tokens',
  video_tokens: 'video_cache_tokens',
}

function money(cell: string | undefined): number | null | 'bad' {
  const text = cell?.trim() ?? ''
  if (text === '' || /^n\/a$/i.test(text)) return null
  const match = /^\$([\d,]+(?:\.\d+)?)$/.exec(text)
  if (!match?.[1]) return 'bad'
  return Number(match[1].replace(/,/g, '')) / 1e6
}

function activeName(
  name: string,
  now: number,
): { key: string; expiresAt: string | null } | null {
  if (/\bcomputer use\b/i.test(name)) return null
  const through = /through ([A-Za-z]+ \d{1,2}, \d{4})/i.exec(name)
  const starting = /starting ([A-Za-z]+ \d{1,2}, \d{4})/i.exec(name)
  let end: number | null = null
  if (through?.[1]) {
    const day = parseDay(through[1])
    if (day === null) return null
    end = day + DAY_MS
    if (now >= end) return null
  }
  if (starting?.[1]) {
    const day = parseDay(starting[1])
    if (day === null) return null
    if (now < day) return null
  }
  const key = normModelName(name)
  if (!key) return null
  return {
    key,
    expiresAt: end === null ? null : new Date(end).toISOString(),
  }
}

function readPrice(row: Array<string>, index: number): number | null | 'bad' {
  if (index < 0) return null
  return money(row[index])
}

/** Normed display name → rates. A poisoned name is absent. */
export function parseVertexPricing(
  html: string,
  now: number = Date.now(),
): Map<string, VertexRates> {
  const groups = new Map<string, PriceGroup>()
  const poisoned = new Set<string>()
  for (const match of html.matchAll(/<table[\s\S]*?<\/table>/gi)) {
    const rows = [...match[0].matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((row) =>
      cells(row[0]),
    )
    const header = rows[0]
    if (!header) continue
    const columns = columnsOf(header)
    if (!columns) continue
    let modelName = ''
    let region = ''
    for (const row of rows.slice(1)) {
      if (row[columns.model]) {
        modelName = row[columns.model] ?? ''
        region = columns.region >= 0 ? (row[columns.region] ?? '') : ''
      } else if (columns.region >= 0 && row[columns.region]) {
        region = row[columns.region] ?? ''
      }
      const named = activeName(modelName, now)
      if (!named || poisoned.has(named.key)) continue
      const type = row[columns.type] ?? ''
      if (type === '' || /^type$/i.test(type)) continue
      const prices = [
        readPrice(row, columns.shortIn),
        readPrice(row, columns.longIn),
        readPrice(row, columns.shortCache),
        readPrice(row, columns.longCache),
      ] as const
      if (prices.some((price) => price === 'bad')) {
        poisoned.add(named.key)
        groups.delete(named.key)
        continue
      }
      const group = groups.get(named.key) ?? {
        rows: [],
        expiresAt: named.expiresAt,
      }
      if (named.expiresAt) group.expiresAt = named.expiresAt
      group.rows.push({
        type,
        region,
        prices: prices.map((price) =>
          price === 'bad' ? null : price,
        ) as PriceRow['prices'],
      })
      groups.set(named.key, group)
    }
  }

  const out = new Map<string, VertexRates>()
  for (const [key, group] of groups) {
    if (poisoned.has(key)) continue
    const rates = ratesFor(group)
    if (rates) out.set(key, rates)
  }
  return out
}

function ratesFor(group: PriceGroup): VertexRates | null {
  const global = group.rows.some((row) => /^global$/i.test(row.region))
  const rows = global
    ? group.rows.filter(
        (row) => row.region === '' || /^global$/i.test(row.region),
      )
    : group.rows
  const base: Record<string, number> = {}
  const tier: Record<string, number> = {}
  let tiered = false
  for (const row of rows) {
    const levers = priceLevers(row.type)
    const [shortIn, longIn, shortCache, longCache] = row.prices
    if (!levers) {
      if (row.prices.some((price) => price !== null)) return null
      continue
    }
    if (shortIn === null) return null
    for (const lever of levers) {
      if (base[lever] !== undefined && base[lever] !== shortIn) return null
      base[lever] = shortIn
      if (longIn !== null && longIn !== shortIn) {
        if (tier[lever] !== undefined && tier[lever] !== longIn) return null
        tier[lever] = longIn
        tiered = true
      }
      const cacheLever = CACHE_LEVER[lever]
      if (!cacheLever || shortCache === null) continue
      if (base[cacheLever] !== undefined && base[cacheLever] !== shortCache) {
        return null
      }
      base[cacheLever] = shortCache
      if (longCache !== null && longCache !== shortCache) {
        if (tier[cacheLever] !== undefined && tier[cacheLever] !== longCache) {
          return null
        }
        tier[cacheLever] = longCache
        tiered = true
      }
    }
  }
  if (base.input_tokens === undefined || base.output_tokens === undefined) {
    return null
  }
  const tiers: Array<TokenRateTier> = tiered
    ? [{ minPromptTokens: LONG_CONTEXT, rates: tier }]
    : []
  return {
    base,
    tiers,
    ...(group.expiresAt ? { expiresAt: group.expiresAt } : {}),
  }
}

type PricedFacts = Pick<ModelInfo, 'pricing' | 'factSources'>

/** Card-title lookup. Names the page does not price get nothing. */
export async function vertexModelPricing(
  kv?: KVNamespace,
): Promise<(title: string) => PricedFacts> {
  const doc = await cachedDocs(kv, VERTEX_PRICING_URL, async () => {
    const html = await fetchText(VERTEX_PRICING_URL)
    const parsed = parseVertexPricing(html)
    assertParsed(parsed, 'vertex pricing page')
    return {
      rates: Object.fromEntries(parsed),
      hash: await sha256Text(html),
      extractedAt: new Date().toISOString(),
    }
  })
  return (title) => {
    const rates = doc.rates[normModelName(title)]
    if (!rates) return {}
    const source = {
      url: VERTEX_PRICING_URL,
      hash: doc.hash,
      extractedAt: doc.extractedAt,
      ...(rates.expiresAt ? { expiresAt: rates.expiresAt } : {}),
    }
    const pricing = compileTokenCard(rates.base, rates.tiers, source, {
      extraPromptLevers: ['audio_tokens', 'image_tokens', 'video_tokens'],
    })
    if (!pricing) return {}
    return {
      pricing,
      factSources: tagDocsFacts({ pricing }, VERTEX_PRICING_URL, doc.hash),
    }
  }
}

/** The rate map compileTokenCard stored, for tests. */
export function baseRates(card: RateCard): Record<string, number> {
  const table = card.tables.rate
  const base = table && typeof table === 'object' ? table.base : undefined
  if (!base || typeof base !== 'object') return {}
  return Object.fromEntries(
    Object.entries(base).filter(
      (entry): entry is [string, number] => typeof entry[1] === 'number',
    ),
  )
}
