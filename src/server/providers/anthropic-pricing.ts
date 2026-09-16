/**
 * Claude prices from Anthropic's own pricing page (issue #61). The "Model
 * pricing" section is one markdown table keyed by display name — the same
 * string the Models API returns as `display_name` — with a `$x / MTok`
 * column per lever. A parse of zero rows throws rather than nulling stored
 * cards; a model the table does not name simply gets none.
 *
 * Batch, tool-use (search, code execution) and long-context premiums are
 * priced elsewhere on the page and are not levers here: a card quotes the
 * standard per-token rates.
 */
import { compileTokenCard } from '@modelschemas/rate-card'

import { tagDocsFacts } from './fact-sources.ts'
import {
  assertParsed,
  cachedDocs,
  markdownSection,
  markdownTableRows,
} from './model-facts.ts'
import { fetchText, sha256Text } from './types.ts'
import type { ModelInfo } from './types.ts'

export const ANTHROPIC_PRICING_URL =
  'https://platform.claude.com/docs/en/about-claude/pricing.md'

/** Column heading → the lever it prices. Unlisted columns are ignored. */
const COLUMN_LEVERS: Array<[RegExp, string]> = [
  [/^base input/, 'input_tokens'],
  [/^5m cache writes/, 'cache_write_tokens'],
  [/^1h cache writes/, 'cache_write_1h_tokens'],
  [/^cache hits/, 'cache_read_tokens'],
  [/^output/, 'output_tokens'],
]

function lever(heading: string): string | null {
  const normalized = heading.trim().toLowerCase()
  return COLUMN_LEVERS.find(([match]) => match.test(normalized))?.[1] ?? null
}

/** `$12.50 / MTok` (footnote markers allowed) → USD per token. */
function perToken(cell: string | undefined): number | null {
  const amount = cell?.match(/^\$([\d,]+(?:\.\d+)?)\s*\/\s*MTok\d*$/)?.[1]
  return amount === undefined ? null : Number(amount.replace(/,/g, '')) / 1e6
}

/**
 * Display name (lowercased) → per-token rates. The name cell carries
 * markdown links for retired/limited models (`Claude Opus 4 ([retired…])`);
 * only the plain name before them keys the row.
 */
export function parseAnthropicPricing(
  markdown: string,
): Map<string, Record<string, number>> {
  const out = new Map<string, Record<string, number>>()
  let levers: Array<string | null> = []
  for (const cells of markdownTableRows(
    markdownSection(markdown, 'Model pricing'),
  )) {
    const [name = '', ...values] = cells
    if (/^model$/i.test(name)) {
      levers = values.map(lever)
      continue
    }
    if (levers.length === 0) continue
    const key = name
      .replace(/\s*[([].*$/, '')
      .trim()
      .toLowerCase()
    const rates: Record<string, number> = {}
    values.forEach((cell, index) => {
      const target = levers[index]
      const rate = perToken(cell)
      if (target && rate !== null) rates[target] = rate
    })
    if (key && Object.keys(rates).length > 0 && !out.has(key)) {
      out.set(key, rates)
    }
  }
  return out
}

type PricedFacts = Pick<ModelInfo, 'pricing' | 'factSources'>

/** Card lookup by `display_name`; models off the table get nothing. */
export async function anthropicModelPricing(
  kv?: KVNamespace,
): Promise<(displayName: string | null | undefined) => PricedFacts> {
  const doc = await cachedDocs(kv, ANTHROPIC_PRICING_URL, async () => {
    const markdown = await fetchText(ANTHROPIC_PRICING_URL)
    const parsed = parseAnthropicPricing(markdown)
    assertParsed(parsed, 'anthropic pricing page')
    return {
      rates: Object.fromEntries(parsed),
      hash: await sha256Text(markdown),
      extractedAt: new Date().toISOString(),
    }
  })
  return (displayName) => {
    const rates = doc.rates[(displayName ?? '').trim().toLowerCase()]
    const pricing = rates
      ? compileTokenCard(rates, [], {
          url: ANTHROPIC_PRICING_URL,
          hash: doc.hash,
          extractedAt: doc.extractedAt,
        })
      : null
    if (!pricing) return {}
    return {
      pricing,
      factSources: tagDocsFacts({ pricing }, ANTHROPIC_PRICING_URL, doc.hash),
    }
  }
}
