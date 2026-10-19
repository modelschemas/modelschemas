/**
 * Stability prices from the pricing docs (issues #122, #362). The page
 * moved to Mintlify at docs.stability.ai, which serves it as markdown:
 * `1 credit = $0.01`, then `| Service | Description | Price (credits) |`
 * tables. A service whose price is a single credit count becomes that
 * many cents per request. "From 0.9" is not a single amount, so that
 * service stays unpriced. A page that prices nothing throws.
 */
import { compileUnitCard } from '@modelschemas/rate-card'
import type { RateCard } from '@modelschemas/rate-card'

import { tagDocsFacts } from './fact-sources.ts'
import { assertParsed, markdownTableRows } from './model-facts.ts'
import type { cachedDocs } from './model-facts.ts'
import { fetchText, sha256Text } from './types.ts'
import type { ModelInfo } from './types.ts'

export const STABILITY_PRICING_URL = 'https://docs.stability.ai/pricing.md'

const CREDIT_USD = /1 credit = \\?\$(\d+(?:\.\d+)?)/
const EXACT_CREDITS = /^\d+(?:\.\d+)?$/
/** `[Stable Image Ultra](/api-reference/...)` → `Stable Image Ultra`. */
const LINKED_NAME = /^\[([^\]]+)\]\([^)]*\)$/

/** Service name → USD per request. Inexact prices are absent. */
export function parseStabilityPricing(source: string): Map<string, number> {
  const credit = source.match(CREDIT_USD)?.[1]
  if (credit === undefined) return new Map()
  const usd = Number(credit)
  const out = new Map<string, number>()
  for (const [service, , price] of markdownTableRows(source)) {
    if (service === undefined || price === undefined) continue
    const name = service.match(LINKED_NAME)?.[1] ?? service
    if (!EXACT_CREDITS.test(price) || out.has(name)) continue
    out.set(name, Number(price) * usd)
  }
  return out
}

type PricedFacts = Pick<ModelInfo, 'pricing' | 'factSources'>

/**
 * Card lookup by the pricing page's service name. Catalog engine ids that
 * the page does not name (including SDXL's "From 0.9") get no card. Load
 * it through `tryDocs`; this throws when the page prices nothing.
 */
export async function stabilityModelPricing(
  kv: KVNamespace | undefined,
  cached: typeof cachedDocs,
): Promise<(rawId: string) => PricedFacts> {
  const doc = await cached(kv, STABILITY_PRICING_URL, async () => {
    const source = await fetchText(STABILITY_PRICING_URL)
    const parsed = parseStabilityPricing(source)
    assertParsed(parsed, 'stability pricing page')
    return {
      rates: Object.fromEntries(parsed),
      hash: await sha256Text(source),
      extractedAt: new Date().toISOString(),
    }
  })
  return (rawId) => {
    const usd = doc.rates[rawId]
    if (usd === undefined) return {}
    const pricing: RateCard | null = compileUnitCard(
      { rates: usd },
      {
        url: STABILITY_PRICING_URL,
        hash: doc.hash,
        extractedAt: doc.extractedAt,
      },
    )
    if (!pricing) return {}
    return {
      pricing,
      factSources: tagDocsFacts({ pricing }, STABILITY_PRICING_URL, doc.hash),
    }
  }
}
