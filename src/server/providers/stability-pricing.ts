/**
 * Stability prices from the pricing app bundle (issue #122). The HTML
 * shell is empty; the published table lives in the script it loads.
 * `1 credit = $0.01`, and a service whose price is a single credit count
 * becomes that many cents per request. "From 0.9" is not a single amount,
 * so that service stays unpriced. A page that prices nothing throws.
 */
import { compileUnitCard } from '@modelschemas/rate-card'
import type { RateCard } from '@modelschemas/rate-card'

import { tagDocsFacts } from './fact-sources.ts'
import { assertParsed, cachedDocs } from './model-facts.ts'
import { fetchText, sha256Text } from './types.ts'
import type { ModelInfo } from './types.ts'

export const STABILITY_PRICING_URL = 'https://platform.stability.ai/pricing'

const SERVICE =
  /\{id:"([^"]+)",service:"([^"]+)",description:"[^"]*",price:"([^"]+)"/g
const CREDIT_USD = /1 credit = \$(\d+(?:\.\d+)?)/
const EXACT_CREDITS = /^\d+(?:\.\d+)?$/

/** Service id → USD per request. Inexact prices are absent. */
export function parseStabilityPricing(source: string): Map<string, number> {
  const credit = source.match(CREDIT_USD)?.[1]
  if (credit === undefined) return new Map()
  const usd = Number(credit)
  const out = new Map<string, number>()
  for (const match of source.matchAll(SERVICE)) {
    const id = match[1]
    const price = match[3]
    if (!id || !price || !EXACT_CREDITS.test(price) || out.has(id)) continue
    out.set(id, Number(price) * usd)
  }
  return out
}

async function loadStabilityPricingSource(): Promise<string> {
  const html = await fetchText(STABILITY_PRICING_URL)
  const src = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1]
  if (!src) {
    throw new Error('stability pricing: page has no app script')
  }
  return fetchText(new URL(src, STABILITY_PRICING_URL).href)
}

type PricedFacts = Pick<ModelInfo, 'pricing' | 'factSources'>

/**
 * Card lookup by the pricing page's service id. Catalog engine ids that
 * the page does not name (including SDXL's "From 0.9") get no card.
 */
export async function stabilityModelPricing(
  kv?: KVNamespace,
): Promise<(rawId: string) => PricedFacts> {
  const doc = await cachedDocs(kv, STABILITY_PRICING_URL, async () => {
    const source = await loadStabilityPricingSource()
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
