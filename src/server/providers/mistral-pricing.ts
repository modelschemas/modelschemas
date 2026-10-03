/**
 * Mistral prices from the docs pricing page (issue #73, unit rows #116).
 * Sections marked "Prices /M Tokens" are standard per-million rates (input,
 * cached input, output). Batch and priority live in other tabs and are not
 * in that table. A cell with a unit ("$4 /1000 Pages", "$0.003 /Min",
 * "$16 /M Chars") is a unit rate, not a token rate. A row is one unit card
 * when every priced cell names that same unit. Several positive prices of
 * that unit (input and cached pages) are separate usage meters. A zero
 * amount is not a meter. Mixed units, an unknown unit, or "Free" is no card.
 *
 * The table keys docs slugs (`mistral-large-3-25-12`). The model page names
 * the API ids that slug serves (`mistral-large-2512`, `mistral-large-latest`).
 * An API id named by two slugs at different rates gets no card.
 */
import { compileTokenCard, compileUnitCard } from '@modelschemas/rate-card'
import type { RateCard } from '@modelschemas/rate-card'

import { tagDocsFacts } from './fact-sources.ts'
import { assertParsed, cachedDocs, mapConcurrent } from './model-facts.ts'
import { fetchText, sha256Text } from './types.ts'
import type { ModelInfo } from './types.ts'

export const MISTRAL_PRICING_URL = 'https://docs.mistral.ai/inference/pricing'
export const MISTRAL_CHANGELOG_URL =
  'https://docs.mistral.ai/resources/changelogs'
const MISTRAL_MODEL_PAGE = (slug: string) =>
  `https://docs.mistral.ai/models/${slug}`

export interface MistralTokenRates {
  kind: 'tokens'
  rates: Record<string, number>
}

/** One billed quantity. Cached meters default to 0; the primary does not. */
export interface MistralUnitMeter {
  param: string
  /** USD per one unit (one page, one minute, one character). */
  rate: number
  default?: number
}

export interface MistralUnitRates {
  kind: 'unit'
  meters: Array<MistralUnitMeter>
}

export type MistralListedPrice = MistralTokenRates | MistralUnitRates

const UNIT_PARAMS = {
  pages: ['pages', 'cached_pages', 'output_pages'],
  audio_minutes: [
    'audio_minutes',
    'cached_audio_minutes',
    'output_audio_minutes',
  ],
  characters: ['characters', 'cached_characters', 'output_characters'],
} as const

type MistralUnit = keyof typeof UNIT_PARAMS

/** `$4 /1000 Pages`, `$0.003 /Min`, `$16 /M Chars`. `undefined` is `—`. */
function unitCell(
  cell: string,
): { unit: MistralUnit; rate: number } | null | undefined {
  if (cell === '—' || cell === '–' || cell === '-' || cell === '') {
    return undefined
  }
  const match = cell.match(
    /^\$([\d,]+(?:\.\d+)?)\s*\/\s*(?:(\d[\d,]*)\s+)?(.+)$/,
  )
  if (!match?.[1] || !match[3]) return null
  const amount = Number(match[1].replace(/,/g, ''))
  const count = match[2] ? Number(match[2].replace(/,/g, '')) : 1
  const label = match[3].trim().toLowerCase()
  const unit: MistralUnit | null =
    label === 'page' || label === 'pages'
      ? 'pages'
      : label === 'min' ||
          label === 'mins' ||
          label === 'minute' ||
          label === 'minutes'
        ? 'audio_minutes'
        : label === 'm char' || label === 'm chars' || label === 'm characters'
          ? 'characters'
          : null
  if (
    !unit ||
    !Number.isFinite(amount) ||
    !Number.isFinite(count) ||
    count <= 0
  ) {
    return null
  }
  const rate = unit === 'characters' ? amount / 1e6 / count : amount / count
  return { unit, rate }
}

function cellText(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

/** `$0.5` per million tokens. `undefined` is an absent lever (`—`). */
function perMillion(cell: string): number | null | undefined {
  if (cell === '—' || cell === '–' || cell === '-' || cell === '') {
    return undefined
  }
  const amount = cell.match(/^\$([\d,]+(?:\.\d+)?)$/)?.[1]
  if (amount === undefined) return null
  return Number(amount.replace(/,/g, '')) / 1e6
}

/** Input, cached input, then output. A zero amount publishes no meter. */
function unitMeters(cells: Array<string>): Array<MistralUnitMeter> | null {
  const priced: Array<MistralUnitMeter & { unit: MistralUnit }> = []
  for (const [index, column] of [1, 2, 3].entries()) {
    const parsed = unitCell(cells[column] ?? '')
    if (parsed === null) return null
    if (!parsed || parsed.rate === 0) continue
    const param = UNIT_PARAMS[parsed.unit][index]
    if (!param) return null
    priced.push({ unit: parsed.unit, param, rate: parsed.rate })
  }
  if (priced.length === 0) return null
  const unit = priced[0]?.unit
  if (!unit || priced.some((meter) => meter.unit !== unit)) return null
  return priced.map((meter, index) => ({
    param: meter.param,
    rate: meter.rate,
    ...(index > 0 ? { default: 0 } : {}),
  }))
}

/**
 * Docs slug → token or unit rates. Token sections skip a row that is not a
 * plain per-million amount. Other sections accept one unit only.
 */
export function parseMistralPricing(
  html: string,
): Map<string, MistralListedPrice> {
  const out = new Map<string, MistralListedPrice>()
  for (const section of html.split(/<h2\b[^>]*>/i).slice(1)) {
    const tokens = /Prices\s*\/\s*M Tokens/i.test(section)
    const table = section.match(/<table\b[\s\S]*?<\/table>/i)?.[0] ?? ''
    for (const row of table.matchAll(/<tr\b[\s\S]*?<\/tr>/gi)) {
      const slug = row[0].match(/href="\/models\/([^"]+)"/)?.[1]
      if (!slug || out.has(slug)) continue
      const cells = [...row[0].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(
        ([, cell = '']) => cellText(cell),
      )
      if (cells.some((cell) => /^free$/i.test(cell))) continue
      if (tokens) {
        const input = perMillion(cells[1] ?? '')
        const cached = perMillion(cells[2] ?? '')
        const output = perMillion(cells[3] ?? '')
        if (input === null || cached === null || output === null) continue
        if (input === undefined) continue
        const rates: Record<string, number> = { input_tokens: input }
        if (cached !== undefined) rates.cache_read_tokens = cached
        if (output !== undefined) rates.output_tokens = output
        out.set(slug, { kind: 'tokens', rates })
        continue
      }
      const meters = unitMeters(cells)
      if (!meters) continue
      out.set(slug, { kind: 'unit', meters })
    }
  }
  return out
}

/** The card `mistralModelPricing` stores. `null` when the row prices nothing. */
export function mistralRateCard(
  row: MistralListedPrice,
  source: RateCard['source'],
): RateCard | null {
  if (row.kind === 'tokens') return compileTokenCard(row.rates, [], source)
  const [first, ...rest] = row.meters
  if (!first || first.rate <= 0) return null
  const card = compileUnitCard(
    {
      quantity: {
        param: first.param,
        bound: 'usage',
        ...(first.default !== undefined ? { default: first.default } : {}),
      },
      rates: first.rate,
    },
    source,
  )
  if (!card || rest.length === 0) return card
  return {
    ...card,
    inputs: {
      ...card.inputs,
      ...Object.fromEntries(
        rest.map((meter) => [
          meter.param,
          {
            param: meter.param,
            bound: 'usage' as const,
            kind: 'number' as const,
            ...(meter.default !== undefined ? { default: meter.default } : {}),
          },
        ]),
      ),
    },
    price: {
      '+': [
        card.price,
        ...rest.map((meter) => ({ '*': [{ var: meter.param }, meter.rate] })),
      ],
    },
  }
}

/**
 * API ids a model page says the slug serves. The payload carries
 * `"names":["mistral-large-2512","mistral-large-latest"]`. When several
 * arrays match, the one sharing the most slug tokens wins; a tie that
 * shares nothing is no mapping.
 */
export function parseMistralApiIds(html: string, slug: string): Array<string> {
  // The page embeds the array as JSON (`"names":["id"]`) and, in the RSC
  // payload, with escaped quotes (`names\":["id"]`).
  const blocks = [
    ...html.matchAll(/"names":\[([^\]]*)\]/g),
    ...html.matchAll(/names\\":\[([^\]]*)\]/g),
  ].flatMap((match) => {
    const body = match[1] ?? ''
    const ids = [
      ...body.matchAll(/"([^"\\]+)"/g),
      ...body.matchAll(/\\"([^"\\]+)\\"/g),
    ].map(([, id = '']) => id)
    return ids.length > 0 &&
      ids.every((id) => /^[a-z0-9][a-z0-9._/-]*$/.test(id))
      ? [ids]
      : []
  })
  if (blocks.length === 0) return []
  const tokens = slug.split('-').filter((token) => token.length > 1)
  const score = (ids: Array<string>) =>
    ids.reduce(
      (total, id) =>
        total + tokens.filter((token) => id.includes(token)).length,
      0,
    )
  const ranked = [...blocks].sort((a, b) => score(b) - score(a))
  const best = ranked[0] ?? []
  const bestScore = score(best)
  if (bestScore === 0 && blocks.length > 1) return []
  return best
}

export interface MistralModelPage {
  slug: string
  ids: Array<string>
  hash: string
}

/**
 * API id → rates. A priced slug with no ids throws: caching a partial map
 * would drop those models' stored cards for the cache TTL.
 */
export function indexMistralApiIds(
  bySlug: Map<string, MistralListedPrice>,
  pages: Array<MistralModelPage>,
): Map<string, MistralListedPrice> {
  const bySlugPage = new Map(pages.map((page) => [page.slug, page]))
  const missing = [...bySlug.keys()].filter(
    (slug) => (bySlugPage.get(slug)?.ids.length ?? 0) === 0,
  )
  if (missing.length > 0) {
    throw new Error(`mistral model pages: no API ids for ${missing.join(', ')}`)
  }
  const byId = new Map<string, MistralListedPrice>()
  const conflicts = new Set<string>()
  for (const page of pages) {
    const rates = bySlug.get(page.slug)
    if (!rates) continue
    const serialized = JSON.stringify(rates)
    for (const id of page.ids) {
      const prior = byId.get(id)
      if (!prior) {
        byId.set(id, rates)
        continue
      }
      if (JSON.stringify(prior) !== serialized) conflicts.add(id)
    }
  }
  for (const id of conflicts) byId.delete(id)
  return byId
}

/**
 * Deprecated id → successor, when the changelog says the successor is the
 * same price. OCR and Voxtral stay out of this map (issue #116).
 */
export function parseMistralSamePrice(html: string): Map<string, string> {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
  const out = new Map<string, string>()
  const pattern =
    /\(\s*([a-z0-9-]+)\s*\)\s+is deprecated[\s\S]{0,300}?Use[\s\S]{0,200}?\(\s*([a-z0-9-]+)\s*\)\s+instead, at the same price/gi
  for (const match of text.matchAll(pattern)) {
    const from = match[1]
    const to = match[2]
    if (!from || !to || from === to) continue
    if (/ocr|voxtral|embed/.test(from) || /ocr|voxtral|embed/.test(to)) {
      continue
    }
    out.set(from, to)
  }
  return out
}

type PricedFacts = Pick<ModelInfo, 'pricing' | 'factSources'>

/** Card lookup by API model id. */
export async function mistralModelPricing(
  kv?: KVNamespace,
): Promise<(rawId: string) => PricedFacts> {
  const doc = await cachedDocs(kv, MISTRAL_PRICING_URL, async () => {
    const [html, changelog] = await Promise.all([
      fetchText(MISTRAL_PRICING_URL),
      fetchText(MISTRAL_CHANGELOG_URL),
    ])
    const bySlug = parseMistralPricing(html)
    assertParsed(bySlug, 'mistral pricing page')
    const pages = await mapConcurrent([...bySlug.keys()], 6, async (slug) => {
      const url = MISTRAL_MODEL_PAGE(slug)
      const page = await cachedDocs(kv, url, async () => {
        const body = await fetchText(url)
        const ids = parseMistralApiIds(body, slug)
        if (ids.length === 0) {
          throw new Error(`mistral model page ${slug}: parsed 0 API ids`)
        }
        return { ids, hash: await sha256Text(body) }
      })
      return { slug, ids: page.ids, hash: page.hash }
    })
    const byId = indexMistralApiIds(bySlug, pages)
    for (const [from, to] of parseMistralSamePrice(changelog)) {
      const rates = byId.get(to)
      if (!rates || byId.has(from)) continue
      byId.set(from, rates)
    }
    assertParsed(byId, 'mistral model pages')
    const hash = await sha256Text(
      [
        await sha256Text(html),
        await sha256Text(changelog),
        ...pages.map((page) => `${page.slug} ${page.hash}`).sort(),
      ].join('\n'),
    )
    return {
      rates: Object.fromEntries(byId),
      hash,
      extractedAt: new Date().toISOString(),
    }
  })
  return (rawId) => {
    const row = doc.rates[rawId]
    const pricing = row
      ? mistralRateCard(row, {
          url: MISTRAL_PRICING_URL,
          hash: doc.hash,
          extractedAt: doc.extractedAt,
        })
      : null
    if (!pricing) return {}
    return {
      pricing,
      factSources: tagDocsFacts({ pricing }, MISTRAL_PRICING_URL, doc.hash),
    }
  }
}
