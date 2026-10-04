/**
 * Fireworks serverless prices (issue #109). The headline table's Standard
 * cell is input / cached input / output, USD per 1M tokens. Priority is a
 * separate serving mode and is not the default card. "(US)" rows share a
 * slug with the base row at a different rate, so they are skipped rather
 * than merged. Size-band tables name no API id and are ignored. Fast rows
 * bind to `accounts/fireworks/routers/<slug>-fast`.
 */
import { compileTokenCard } from '@modelschemas/rate-card'

import { assertParsed, cachedDocs, markdownTableRows } from './model-facts.ts'
import { fetchText, sha256Text } from './types.ts'
import type { ModelInfo } from './types.ts'

export const FIREWORKS_PRICING_URL =
  'https://docs.fireworks.ai/serverless/pricing.md'

export interface FireworksRates {
  input: number
  cacheRead: number
  output: number
}

function standardRates(cell: string): FireworksRates | null {
  const text = cell.replace(/\\/g, '').replace(/\s+/g, '')
  const match = text.match(
    /^\$(\d+(?:\.\d+)?)\/\$(\d+(?:\.\d+)?)\/\$(\d+(?:\.\d+)?)$/,
  )
  if (!match?.[1] || !match[2] || !match[3]) return null
  return {
    input: Number(match[1]),
    cacheRead: Number(match[2]),
    output: Number(match[3]),
  }
}

/** API id → Standard USD per million tokens. */
export function parseFireworksPricing(
  markdown: string,
): Map<string, FireworksRates> {
  const out = new Map<string, FireworksRates>()
  const dropped = new Set<string>()
  for (const cells of markdownTableRows(markdown.replace(/^ +\|/gm, '|'))) {
    const label = cells[0] ?? ''
    const rates = standardRates(cells[1] ?? '')
    const slug = label.match(/models\/fireworks\/([A-Za-z0-9._-]+)/)?.[1]
    if (!slug || !rates) continue
    const name = (label.match(/\[([^\]]+)\]/)?.[1] ?? label).replace(/\\/g, '')
    if (/\(US\)/i.test(name)) continue
    const id = /fast/i.test(name)
      ? `accounts/fireworks/routers/${slug}-fast`
      : `accounts/fireworks/models/${slug}`
    if (out.has(id) || dropped.has(id)) {
      out.delete(id)
      dropped.add(id)
      continue
    }
    out.set(id, rates)
  }
  return out
}

type PricedFacts = Pick<ModelInfo, 'pricing'>

export async function fireworksModelPricing(
  kv?: KVNamespace,
): Promise<(rawId: string) => PricedFacts> {
  const doc = await cachedDocs(kv, FIREWORKS_PRICING_URL, async () => {
    const markdown = await fetchText(FIREWORKS_PRICING_URL)
    const parsed = parseFireworksPricing(markdown)
    assertParsed(parsed, 'fireworks pricing page')
    return {
      rates: Object.fromEntries(parsed),
      hash: await sha256Text(markdown),
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
        url: FIREWORKS_PRICING_URL,
        hash: doc.hash,
        extractedAt: doc.extractedAt,
      },
    )
    return pricing ? { pricing } : {}
  }
}
