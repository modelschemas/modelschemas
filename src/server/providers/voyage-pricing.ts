/**
 * Voyage prices from the published pricing page (issue #122). Token rows
 * are dollars per million tokens. Multimodal rows also name dollars per
 * billion pixels. A model named twice at different rates is dropped. A
 * page that prices nothing throws.
 */
import { compileTokenCard } from '@modelschemas/rate-card'
import type { RateCard } from '@modelschemas/rate-card'

import { tagDocsFacts } from './fact-sources.ts'
import { assertParsed, cachedDocs, markdownTableRows } from './model-facts.ts'
import { fetchText, sha256Text } from './types.ts'
import type { ModelInfo } from './types.ts'

export const VOYAGE_PRICING_URL = 'https://docs.voyageai.com/docs/pricing.md'

const MODEL_ID = /voyage-[a-z0-9.-]+/g
const DOLLARS = /^\$(\d+(?:\.\d+)?)$/

export interface VoyageRates {
  /** USD per token, from the "per million tokens" column. */
  inputTokens: number
  /** USD per pixel, when the row also prices pixels. */
  pixels?: number
}

function headerIndex(cells: Array<string>, needle: string): number {
  return cells.findIndex((cell) => cell.toLowerCase().includes(needle))
}

/** Model id → rates the pricing page states. Conflicting ids are absent. */
export function parseVoyagePricing(markdown: string): Map<string, VoyageRates> {
  const out = new Map<string, VoyageRates>()
  const dropped = new Set<string>()
  let million = -1
  let pixels = -1
  for (const cells of markdownTableRows(markdown)) {
    const modelCol = headerIndex(cells, 'model')
    const nextMillion = headerIndex(cells, 'per million')
    if (modelCol >= 0 && nextMillion >= 0) {
      million = nextMillion
      pixels = headerIndex(cells, 'per billion pixels')
      continue
    }
    if (million < 0) continue
    const ids = (cells[0] ?? '').match(MODEL_ID) ?? []
    const perMillion = (cells[million] ?? '').match(DOLLARS)?.[1]
    if (ids.length === 0 || perMillion === undefined) continue
    const rates: VoyageRates = { inputTokens: Number(perMillion) / 1e6 }
    if (pixels >= 0) {
      const perBillion = (cells[pixels] ?? '').match(DOLLARS)?.[1]
      if (perBillion === undefined) continue
      rates.pixels = Number(perBillion) / 1e9
    }
    for (const id of ids) {
      const prior = out.get(id)
      if (dropped.has(id)) continue
      if (
        prior &&
        (prior.inputTokens !== rates.inputTokens ||
          prior.pixels !== rates.pixels)
      ) {
        out.delete(id)
        dropped.add(id)
        continue
      }
      out.set(id, rates)
    }
  }
  return out
}

function cardFor(
  rates: VoyageRates,
  source: RateCard['source'],
): RateCard | null {
  const levers: Record<string, number> = { input_tokens: rates.inputTokens }
  if (rates.pixels !== undefined) levers.pixels = rates.pixels
  return compileTokenCard(levers, [], source)
}

type PricedFacts = Pick<ModelInfo, 'pricing' | 'factSources'>

/** Card lookup by listed model id. */
export async function voyageModelPricing(
  kv?: KVNamespace,
): Promise<(rawId: string) => PricedFacts> {
  const doc = await cachedDocs(kv, VOYAGE_PRICING_URL, async () => {
    const markdown = await fetchText(VOYAGE_PRICING_URL)
    const parsed = parseVoyagePricing(markdown)
    assertParsed(parsed, 'voyage pricing page')
    return {
      rates: Object.fromEntries(parsed),
      hash: await sha256Text(markdown),
      extractedAt: new Date().toISOString(),
    }
  })
  return (rawId) => {
    const row = doc.rates[rawId]
    if (!row) return {}
    const pricing = cardFor(row, {
      url: VOYAGE_PRICING_URL,
      hash: doc.hash,
      extractedAt: doc.extractedAt,
    })
    if (!pricing) return {}
    return {
      pricing,
      factSources: tagDocsFacts({ pricing }, VOYAGE_PRICING_URL, doc.hash),
    }
  }
}
