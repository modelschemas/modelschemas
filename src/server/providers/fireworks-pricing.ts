/**
 * Fireworks serverless prices (issue #109). The headline table's Standard
 * cell is input / cached input / output, USD per 1M tokens. Priority is a
 * separate serving mode and is not the default card. "(US)" rows share a
 * slug with the base row at a different rate, so they are skipped rather
 * than merged. Size-band tables name no API id and are ignored. Fast rows
 * bind to `accounts/fireworks/routers/<slug>-fast`.
 */
import { assertParsed, markdownTableRows } from './model-facts.ts'
import type { cachedDocs } from './model-facts.ts'
import { fetchText, sha256Text } from './types.ts'

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

export interface FireworksPricingDoc {
  rates: Record<string, FireworksRates>
  hash: string
  extractedAt: string
}

/** Headline Standard cells. The adapter merges these with the serverless API. */
export function loadFireworksPricingDoc(
  kv: KVNamespace | undefined,
  cached: typeof cachedDocs,
): Promise<FireworksPricingDoc> {
  return cached(kv, FIREWORKS_PRICING_URL, async () => {
    const markdown = await fetchText(FIREWORKS_PRICING_URL)
    const parsed = parseFireworksPricing(markdown)
    assertParsed(parsed, 'fireworks pricing page')
    return {
      rates: Object.fromEntries(parsed),
      hash: await sha256Text(markdown),
      extractedAt: new Date().toISOString(),
    }
  })
}
