/**
 * Kimi prices from the international pricing page (issue #109). Amounts
 * are USD per 1M tokens. K2 rows are cache-hit / cache-miss / output.
 * K3 rows add cache-write TTLs. A zero-row parse throws.
 */
import { compileTokenCard } from '@modelschemas/rate-card'

import { assertParsed, cachedDocs } from './model-facts.ts'
import { fetchText, sha256Text } from './types.ts'
import type { ModelInfo } from './types.ts'

export const MOONSHOT_PRICING_URL =
  'https://platform.kimi.ai/docs/pricing/chat.md'

export interface MoonshotRates {
  input: number
  output: number
  cacheRead: number
  cacheWrite?: number
  cacheWrite1h?: number
}

function dollars(row: string): Array<number> {
  return [...row.matchAll(/\{"\$"\}([\d.]+)/g)].map((match) => Number(match[1]))
}

/** Model id → USD per million tokens. */
export function parseMoonshotPricing(
  markdown: string,
): Map<string, MoonshotRates> {
  const out = new Map<string, MoonshotRates>()
  const rows = markdown.matchAll(/\["(kimi-[^"]+)",\s*"1M tokens",[\s\S]*?\]/g)
  for (const match of rows) {
    const id = match[1]
    const amounts = dollars(match[0])
    if (!id || out.has(id)) continue
    if (amounts.length === 3) {
      const [cacheRead, input, output] = amounts
      if (
        cacheRead === undefined ||
        input === undefined ||
        output === undefined
      ) {
        continue
      }
      out.set(id, { cacheRead, input, output })
    } else if (amounts.length === 5) {
      const [cacheWrite, cacheWrite1h, cacheRead, input, output] = amounts
      if (
        cacheWrite === undefined ||
        cacheWrite1h === undefined ||
        cacheRead === undefined ||
        input === undefined ||
        output === undefined
      ) {
        continue
      }
      out.set(id, { cacheWrite, cacheWrite1h, cacheRead, input, output })
    }
  }
  return out
}

type PricedFacts = Pick<ModelInfo, 'pricing'>

export async function moonshotModelPricing(
  kv?: KVNamespace,
): Promise<(rawId: string) => PricedFacts> {
  const doc = await cachedDocs(kv, MOONSHOT_PRICING_URL, async () => {
    const markdown = await fetchText(MOONSHOT_PRICING_URL)
    const parsed = parseMoonshotPricing(markdown)
    assertParsed(parsed, 'moonshot pricing page')
    return {
      rates: Object.fromEntries(parsed),
      hash: await sha256Text(markdown),
      extractedAt: new Date().toISOString(),
    }
  })
  return (rawId) => {
    const row = doc.rates[rawId]
    if (!row) return {}
    const rates: Record<string, number> = {
      input_tokens: row.input / 1e6,
      output_tokens: row.output / 1e6,
      cache_read_tokens: row.cacheRead / 1e6,
    }
    if (row.cacheWrite) rates.cache_write_tokens = row.cacheWrite / 1e6
    if (row.cacheWrite1h) rates.cache_write_1h_tokens = row.cacheWrite1h / 1e6
    const pricing = compileTokenCard(rates, [], {
      url: MOONSHOT_PRICING_URL,
      hash: doc.hash,
      extractedAt: doc.extractedAt,
    })
    return pricing ? { pricing } : {}
  }
}
