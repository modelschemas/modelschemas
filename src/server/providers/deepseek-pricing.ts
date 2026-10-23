/**
 * DeepSeek prices from the models page (issue #109). Each model publishes
 * off-peak and peak rates. The card holds both behind a required
 * `pricing_period` lever (issue #449, same compiler as BytePlus #411).
 * A page that does not give both sets for every model throws.
 */
import { compilePeriodCard } from './byteplus-pricing.ts'
import type { cachedDocs } from './model-facts.ts'
import { assertParsed } from './model-facts.ts'
import { fetchText, sha256Text } from './types.ts'
import type { ModelInfo } from './types.ts'

/** The trailing slash is load-bearing: without it the docs host serves its home page (issue #369). */
export const DEEPSEEK_PRICING_URL =
  'https://api-docs.deepseek.com/quick_start/pricing/'

export interface DeepseekRates {
  input: number
  cacheRead: number
  output: number
}

/** Both published periods, USD per million tokens. Neither is a default. */
export interface DeepseekPeriodRates {
  off_peak: DeepseekRates
  peak: DeepseekRates
}

function money(line: string): number | null {
  const match = line.match(/^\$(\d+(?:\.\d+)?)$/)
  return match?.[1] ? Number(match[1]) : null
}

/** Both periods, USD per million tokens, keyed by API id. */
export function parseDeepseekPricing(
  html: string,
): Map<string, DeepseekPeriodRates> {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&amp;/g, '&')
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const modelAt = lines.indexOf('MODEL')
  const pricingAt = lines.indexOf('PRICING')
  if (modelAt < 0 || pricingAt < modelAt) return new Map()
  const ids: Array<string> = []
  for (const line of lines.slice(modelAt + 1, pricingAt)) {
    if (/^deepseek-[a-z0-9.-]+$/.test(line)) ids.push(line)
    else if (line.startsWith('BASE URL')) break
  }
  const prices: Array<number> = []
  for (const line of lines.slice(pricingAt + 1)) {
    const value = money(line)
    if (value !== null) prices.push(value)
    else if (prices.length > 0 && line.startsWith('Concurrency')) break
  }
  if (ids.length === 0) return new Map()
  if (prices.length !== ids.length * 6) {
    throw new Error(
      `deepseek pricing page: expected ${ids.length * 6} prices (off-peak and peak for cache read, input, and output), got ${prices.length}`,
    )
  }
  const out = new Map<string, DeepseekPeriodRates>()
  for (const [index, id] of ids.entries()) {
    const at = (row: number) => prices[row * ids.length + index]
    const period = (start: number): DeepseekRates => {
      const cacheRead = at(start)
      const input = at(start + 2)
      const output = at(start + 4)
      if (
        cacheRead === undefined ||
        input === undefined ||
        output === undefined
      ) {
        throw new Error(
          `deepseek pricing page: ${id} is missing an off-peak or peak rate`,
        )
      }
      return { input, cacheRead, output }
    }
    // Rows alternate off-peak then peak: cache, input, output.
    out.set(id, { off_peak: period(0), peak: period(1) })
  }
  return out
}

function perToken(row: DeepseekRates): Record<string, number> {
  return {
    input_tokens: row.input / 1e6,
    output_tokens: row.output / 1e6,
    cache_read_tokens: row.cacheRead / 1e6,
  }
}

type PricedFacts = Pick<ModelInfo, 'pricing' | 'factSources'>

/**
 * Name the body's size and title so a zero-row parse says what came back
 * (issue #367; the title is how #369 found the home page served instead).
 */
function describeBody(html: string): string {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim()
  return `${html.length} chars, title ${JSON.stringify(title ?? null)}`
}

export async function deepseekModelPricing(
  kv: KVNamespace | undefined,
  cached: typeof cachedDocs,
): Promise<(rawId: string) => PricedFacts> {
  const doc = await cached(kv, DEEPSEEK_PRICING_URL, async () => {
    const html = await fetchText(DEEPSEEK_PRICING_URL)
    const parsed = parseDeepseekPricing(html)
    if (parsed.size === 0) {
      throw new Error(
        `deepseek pricing page (${describeBody(html)}): parsed 0 model rows`,
      )
    }
    assertParsed(parsed, 'deepseek pricing page')
    return {
      rates: Object.fromEntries(parsed),
      hash: await sha256Text(html),
      extractedAt: new Date().toISOString(),
    }
  })
  return (rawId) => {
    const row = doc.rates[rawId]
    if (!row) return {}
    const pricing = compilePeriodCard(
      {
        periods: {
          off_peak: perToken(row.off_peak),
          peak: perToken(row.peak),
        },
      },
      {
        url: DEEPSEEK_PRICING_URL,
        hash: doc.hash,
        extractedAt: doc.extractedAt,
      },
    )
    return { pricing }
  }
}
