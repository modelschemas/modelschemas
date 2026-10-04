/**
 * DeepSeek prices from the models page (issue #109). Each model publishes
 * off-peak and peak rates. There is no request lever for the clock, so the
 * card is the off-peak rate (the rate outside the named peak windows).
 * Peak is not stored. A page that does not match this table throws.
 */
import { compileTokenCard } from '@modelschemas/rate-card'

import { assertParsed, cachedDocs } from './model-facts.ts'
import { fetchText, sha256Text } from './types.ts'
import type { ModelInfo } from './types.ts'

export const DEEPSEEK_PRICING_URL =
  'https://api-docs.deepseek.com/quick_start/pricing'

export interface DeepseekRates {
  input: number
  cacheRead: number
  output: number
}

function money(line: string): number | null {
  const match = line.match(/^\$(\d+(?:\.\d+)?)$/)
  return match?.[1] ? Number(match[1]) : null
}

/** Off-peak USD per million tokens, keyed by API id. */
export function parseDeepseekPricing(html: string): Map<string, DeepseekRates> {
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
  if (ids.length === 0 || prices.length !== ids.length * 6) return new Map()
  const out = new Map<string, DeepseekRates>()
  ids.forEach((id, index) => {
    const at = (row: number) => prices[row * ids.length + index]
    const cacheRead = at(0)
    const input = at(2)
    const output = at(4)
    if (
      cacheRead === undefined ||
      input === undefined ||
      output === undefined
    ) {
      return
    }
    out.set(id, { input, cacheRead, output })
  })
  return out
}

type PricedFacts = Pick<ModelInfo, 'pricing' | 'factSources'>

export async function deepseekModelPricing(
  kv?: KVNamespace,
): Promise<(rawId: string) => PricedFacts> {
  const doc = await cachedDocs(kv, DEEPSEEK_PRICING_URL, async () => {
    const html = await fetchText(DEEPSEEK_PRICING_URL)
    const parsed = parseDeepseekPricing(html)
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
    const pricing = compileTokenCard(
      {
        input_tokens: row.input / 1e6,
        output_tokens: row.output / 1e6,
        cache_read_tokens: row.cacheRead / 1e6,
      },
      [],
      {
        url: DEEPSEEK_PRICING_URL,
        hash: doc.hash,
        extractedAt: doc.extractedAt,
      },
    )
    if (!pricing) return {}
    return { pricing }
  }
}
