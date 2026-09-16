/**
 * Gemini prices from Google's own pricing page (issue #61). Google
 * publishes no pricing API and no markdown mirror, so this parses the
 * server-rendered page: one `models-section` per model, the model id in the
 * heading group's `<code>`, and the paid-tier column of the model's
 * "Standard" table.
 *
 * Fail-closed: only the token rows (input / output / context caching) are
 * levers, and any priced row, qualifier or unit the parser does not
 * recognise (per-image, per-minute, per-song, date-conditional, Batch or
 * Flex tables) refuses that model rather than quoting part of its bill.
 * A page that yields no model at all throws, so stored cards survive a
 * layout change until the parser is taught the new one.
 */
import { compileTokenCard } from '@modelschemas/rate-card'
import type { RateCard, TokenRateTier } from '@modelschemas/rate-card'

import { tagDocsFacts } from './fact-sources.ts'
import { assertParsed, cachedDocs, tokenCount } from './model-facts.ts'
import { fetchText, sha256Text } from './types.ts'
import type { ModelInfo } from './types.ts'

export const GEMINI_PRICING_URL =
  'https://ai.google.dev/gemini-api/docs/pricing'

/** Row label → the levers its text and audio prices fill. */
const ROW_LEVERS: Array<[RegExp, { text: string; audio: string }]> = [
  // A parenthetical names the modalities the row covers ("Input price
  // (text, image, video)"); a leading one names one modality and is a
  // different row ("Audio input price"), which this must not match.
  [
    /^input price( \([^)]*\))?$/,
    { text: 'input_tokens', audio: 'audio_tokens' },
  ],
  [
    /^output price( \([^)]*\))?$/,
    { text: 'output_tokens', audio: 'audio_output_tokens' },
  ],
  [
    /^context caching price$/,
    { text: 'cache_read_tokens', audio: 'audio_cache_tokens' },
  ],
]

/** Rows that are not a per-token cost of one request. */
const IGNORED_ROWS =
  /^(grounding with |used to improve|context caching \(storage\)|tuning price|live api)/

/** Modality qualifiers that price the text (default) lever. */
const TEXT_MODALITIES = /^(text|image|video)([ /]+(text|image|video))*$/

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  '#39': "'",
  nbsp: ' ',
}

function plain(html: string): string {
  return (
    html
      // Footnote markers are not part of a price.
      .replace(/<sup>[\s\S]*?<\/sup>/g, '')
      // A real tag only; a bare `<=` in a qualifier must survive.
      .replace(/<\/?[a-zA-Z][^>]*>/g, '')
      .replace(/&([a-z]+|#\d+);/gi, (match, name: string) => {
        return ENTITIES[name.toLowerCase()] ?? match
      })
      .replace(/\s+/g, ' ')
      .trim()
  )
}

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
]

/** `december 31, 2026` → that day's UTC midnight. */
function parseDay(text: string): number | null {
  const match = text.match(/^([a-z]+) (\d{1,2}), (\d{4})$/)
  const month = match?.[1] ? MONTHS.indexOf(match[1]) : -1
  if (!match || month < 0) return null
  return Date.UTC(Number(match[3]), month, Number(match[2]))
}

const DAY_MS = 86_400_000

type Fragment = {
  levers: Array<string>
  rate: number
  tier: number | null
  /** Instant this rate stops applying, for a dated price change. */
  expiresAt: number | null
}

/**
 * One `$x (qualifier)` fragment of a paid-tier cell. `null` refuses the
 * model; `[]` is a fragment that prices nothing here (storage, "not
 * available").
 */
function fragment(
  raw: string,
  levers: { text: string; audio: string },
  now: number,
): Array<Fragment> | null {
  const cell = plain(raw)
  if (cell === '' || /^(not available|free of charge)$/i.test(cell)) return []
  // Cache storage is quoted per token-hour, not per request.
  if (/per hour|storage price/i.test(cell)) return []
  const match = cell.match(/^\$([\d,]+(?:\.\d+)?)\s*(.*)$/)
  if (!match?.[1]) return null
  const rate = Number(match[1].replace(/,/g, '')) / 1e6
  let qualifier = (match[2] ?? '')
    .trim()
    .toLowerCase()
    // A qualifier follows the price as a parenthetical or after a comma.
    .replace(/^,\s*/, '')
    .replace(/\.$/, '')
    .trim()

  // A dated price change ("$0.75 through December 31, 2026" / "$1.50
  // starting January 1, 2027"): the rate in effect now wins and stamps the
  // card's `expiresAt`, so it is re-extracted once the change lands.
  let expiresAt: number | null = null
  const dated = qualifier.match(
    /^(.*?)\s*(through|starting) ([a-z]+ \d{1,2}, \d{4})$/,
  )
  if (dated?.[3]) {
    const day = parseDay(dated[3])
    if (day === null) return null
    const ends = dated[2] === 'through' ? day + DAY_MS : day
    if (dated[2] === 'through' ? now >= ends : now < ends) return []
    if (dated[2] === 'through') expiresAt = ends
    qualifier = (dated[1] ?? '').trim()
  }
  qualifier = qualifier.replace(/^\((.*)\)$/, '$1').trim()

  if (qualifier === '' || qualifier === 'text and thinking') {
    return [{ levers: [levers.text], rate, tier: null, expiresAt }]
  }
  const threshold = qualifier.match(
    /^prompts?\s*(<=|>)\s*([\d,.]+\s*[km]?)\s*(tokens?)?$/,
  )
  if (threshold) {
    const tokens = tokenCount(threshold[2])
    if (tokens === null) return null
    return [
      {
        levers: [levers.text],
        rate,
        tier: threshold[1] === '>' ? tokens : null,
        expiresAt,
      },
    ]
  }
  const parts = qualifier.split(/[,/]/).map((part) => part.trim())
  const audio = parts.includes('audio')
  const rest = parts.filter((part) => part !== 'audio')
  if (audio && rest.length === 0) {
    return [{ levers: [levers.audio], rate, tier: null, expiresAt }]
  }
  if (!TEXT_MODALITIES.test(rest.join(' / '))) return null
  return [
    {
      levers: audio ? [levers.text, levers.audio] : [levers.text],
      rate,
      tier: null,
      expiresAt,
    },
  ]
}

interface ParsedRates {
  base: Record<string, number>
  tiers: Record<number, Record<string, number>>
  expiresAt: number | null
}

function parseTable(segment: string, now: number): ParsedRates | null {
  const out: ParsedRates = { base: {}, tiers: {}, expiresAt: null }
  for (const [, row = ''] of segment.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const cells = [...row.matchAll(/<td>([\s\S]*?)<\/td>/g)].map(
      ([, cell = '']) => cell,
    )
    if (cells.length < 2) continue
    const label = plain(cells[0] ?? '').toLowerCase()
    if (IGNORED_ROWS.test(label)) continue
    const levers = ROW_LEVERS.find(([match]) => match.test(label))?.[1]
    if (!levers) {
      // An unrecognised row that quotes a price is a cost this card would
      // silently drop.
      if (/price|cost|\$/.test(label)) return null
      continue
    }
    const paid = cells[cells.length - 1] ?? ''
    for (const part of paid.split(/<br\s*\/?>/)) {
      const parsed = fragment(part, levers, now)
      if (!parsed) return null
      for (const { levers: filled, rate, tier, expiresAt } of parsed) {
        const target = tier === null ? out.base : (out.tiers[tier] ??= {})
        for (const lever of filled) target[lever] = rate
        if (expiresAt !== null) {
          out.expiresAt = Math.min(out.expiresAt ?? expiresAt, expiresAt)
        }
      }
    }
  }
  return out
}

export interface GeminiRates {
  base: Record<string, number>
  tiers: Array<TokenRateTier>
  /** ISO instant a dated price change takes effect, when the page names one. */
  expiresAt?: string
}

/** Model id → per-token rates parsed from its Standard table. */
export function parseGeminiPricing(
  html: string,
  now: number = Date.now(),
): Map<string, GeminiRates> {
  const out = new Map<string, GeminiRates>()
  for (const chunk of html.split('<div class="models-section">').slice(1)) {
    const id = chunk.match(/<code[^>]*>([a-z0-9][a-z0-9.-]+)<\/code>/)?.[1]
    const end = chunk.indexOf('</table>')
    if (!id || end < 0 || out.has(id)) continue
    const segment = chunk.slice(0, end)
    // Standard rates only: Batch and Flex are separate `<section>` tabs.
    const heading = [...segment.matchAll(/<h3[^>]*data-text="([^"]*)"/g)].at(-1)
    if (heading && heading[1] !== 'Standard') continue
    const parsed = parseTable(segment, now)
    if (!parsed || Object.keys(parsed.base).length === 0) continue
    out.set(id, {
      base: parsed.base,
      tiers: Object.entries(parsed.tiers).map(([min, rates]) => ({
        minPromptTokens: Number(min),
        rates: { ...parsed.base, ...rates },
      })),
      ...(parsed.expiresAt !== null && {
        expiresAt: new Date(parsed.expiresAt).toISOString(),
      }),
    })
  }
  return out
}

type PricedFacts = Pick<ModelInfo, 'pricing' | 'factSources'>

/** Card lookup by model id; ids the page does not price get nothing. */
export async function geminiModelPricing(
  kv?: KVNamespace,
): Promise<(rawId: string) => PricedFacts> {
  const doc = await cachedDocs(kv, GEMINI_PRICING_URL, async () => {
    const html = await fetchText(GEMINI_PRICING_URL)
    const parsed = parseGeminiPricing(html)
    assertParsed(parsed, 'gemini pricing page')
    return {
      rates: Object.fromEntries(parsed),
      hash: await sha256Text(html),
      extractedAt: new Date().toISOString(),
    }
  })
  const card = (rawId: string): RateCard | null => {
    const rates = doc.rates[rawId]
    if (!rates) return null
    return compileTokenCard(rates.base, rates.tiers, {
      url: GEMINI_PRICING_URL,
      hash: doc.hash,
      extractedAt: doc.extractedAt,
      ...(rates.expiresAt && { expiresAt: rates.expiresAt }),
    })
  }
  return (rawId) => {
    // `gemini-2.5-flash-preview-09-2025` is priced by its family row.
    const pricing = card(rawId) ?? card(rawId.replace(/-preview.*$/, ''))
    if (!pricing) return {}
    return {
      pricing,
      factSources: tagDocsFacts({ pricing }, GEMINI_PRICING_URL, doc.hash),
    }
  }
}
