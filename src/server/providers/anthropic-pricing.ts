/**
 * Claude prices from Anthropic's own pricing page (issue #61). The "Model
 * pricing" section is one markdown table keyed by display name — the same
 * string the Models API returns as `display_name` — with a `$x / MTok`
 * column per lever. A parse of zero rows throws rather than nulling stored
 * cards; a model the table does not name simply gets none.
 *
 * Batch and tool-use (search, code execution) prices live in other sections
 * and are not levers here. A model the table splits into "up to N tokens"
 * and "over N tokens" rows (Claude Haiku 5.5, issue #481) is one card: the
 * short row is the base, and the long row is a prompt-length tier at N.
 * The tier fires when input plus cache reads and cache writes are over N,
 * which is the prompt total `compileTokenCard` already sums, and it
 * re-quotes the whole request. A split the table does not pair throws, so
 * a short row is never stored on its own.
 */
import { compileTokenCard } from '@modelschemas/rate-card'
import type { TokenRateTier } from '@modelschemas/rate-card'

import { tagDocsFacts } from './fact-sources.ts'
import {
  assertParsed,
  cachedDocs,
  markdownSection,
  markdownTableRows,
} from './model-facts.ts'
import { fetchText, sha256Text } from './types.ts'
import type { ModelInfo } from './types.ts'
import type { Fetcher } from './us-egress.ts'

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
  // The source markdown retains HTML superscripts on footnoted prices.
  const value = cell?.replace(/<sup>\d+<\/sup>\s*$/, '').trim()
  const amount = value?.match(/^\$([\d,]+(?:\.\d+)?)\s*\/\s*MTok\d*$/)?.[1]
  return amount === undefined ? null : Number(amount.replace(/,/g, '')) / 1e6
}

/** One display name's base rates and any prompt-length re-quote. */
export interface AnthropicModelRates {
  rates: Record<string, number>
  tiers: Array<TokenRateTier>
}

interface PendingRates {
  base: Record<string, number> | null
  long: Record<string, number> | null
  /** Token count on an "up to" row, when that row was read. */
  upTo: number | null
  /** Token count on an "over" row, when that row was read. */
  over: number | null
}

/**
 * `(for prompts up to 100,000 tokens)` / `(for prompts over 100,000 tokens)`.
 * Retirement links stay on the display name and are not a prompt band.
 */
function promptBand(name: string): {
  key: string
  upTo: number | null
  over: number | null
} {
  const labeled =
    /^(.*?)\s+\(for prompts (up to|over) ([\d,]+) tokens\)$/i.exec(name)
  if (labeled?.[1] && labeled[2] && labeled[3]) {
    const count = Number(labeled[3].replace(/,/g, ''))
    if (!Number.isInteger(count) || count <= 0) {
      throw new Error(
        `anthropic pricing page: unreadable prompt-length row "${name}"`,
      )
    }
    const over = labeled[2].toLowerCase() === 'over'
    return {
      key: labeled[1].trim().toLowerCase(),
      upTo: over ? null : count,
      over: over ? count : null,
    }
  }
  if (/for prompts/i.test(name)) {
    throw new Error(
      `anthropic pricing page: unreadable prompt-length row "${name}"`,
    )
  }
  return {
    key: name
      .replace(/\s*[([].*$/, '')
      .trim()
      .toLowerCase(),
    upTo: null,
    over: null,
  }
}

function sameLevers(
  left: Record<string, number>,
  right: Record<string, number>,
): boolean {
  const leftKeys = Object.keys(left)
  return (
    leftKeys.length === Object.keys(right).length &&
    leftKeys.every((key) => right[key] !== undefined)
  )
}

/**
 * Display name (lowercased) → per-token rates. The name cell carries
 * markdown links for retired/limited models (`Claude Opus 4 ([retired…])`);
 * only the plain name before them keys the row. Two rows that name the
 * same model on either side of one prompt length collapse into one entry.
 */
export function parseAnthropicPricing(
  markdown: string,
): Map<string, AnthropicModelRates> {
  const pending = new Map<string, PendingRates>()
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
    const band = promptBand(name)
    const rates: Record<string, number> = {}
    values.forEach((cell, index) => {
      const target = levers[index]
      const rate = perToken(cell)
      if (target && rate !== null) rates[target] = rate
    })
    if (!band.key || Object.keys(rates).length === 0) continue
    const entry = pending.get(band.key) ?? {
      base: null,
      long: null,
      upTo: null,
      over: null,
    }
    const labeled = band.upTo !== null || band.over !== null
    const stored = entry.base !== null || entry.long !== null
    if (labeled !== (entry.upTo !== null || entry.over !== null) && stored) {
      throw new Error(
        `anthropic pricing page: ${band.key} prompt-length rows do not pair`,
      )
    }
    if (band.upTo !== null) {
      if (entry.upTo !== null) {
        throw new Error(
          `anthropic pricing page: ${band.key} prompt-length rows do not pair`,
        )
      }
      entry.base = rates
      entry.upTo = band.upTo
    } else if (band.over !== null) {
      if (entry.over !== null) {
        throw new Error(
          `anthropic pricing page: ${band.key} prompt-length rows do not pair`,
        )
      }
      entry.long = rates
      entry.over = band.over
    } else if (entry.base === null) {
      entry.base = rates
    }
    pending.set(band.key, entry)
  }

  const out = new Map<string, AnthropicModelRates>()
  for (const [key, entry] of pending) {
    const banded = entry.upTo !== null || entry.over !== null
    if (!banded) {
      if (entry.base) out.set(key, { rates: entry.base, tiers: [] })
      continue
    }
    if (
      !entry.base ||
      !entry.long ||
      entry.upTo === null ||
      entry.over === null ||
      entry.upTo !== entry.over ||
      !sameLevers(entry.base, entry.long)
    ) {
      throw new Error(
        `anthropic pricing page: ${key} prompt-length rows do not pair`,
      )
    }
    out.set(key, {
      rates: entry.base,
      tiers: [{ minPromptTokens: entry.over, rates: entry.long }],
    })
  }
  return out
}

type PricedFacts = Pick<ModelInfo, 'pricing' | 'factSources'>

/** Card lookup by `display_name`; models off the table get nothing. */
export async function anthropicModelPricing(
  kv?: KVNamespace,
  cached: typeof cachedDocs = cachedDocs,
  fetcher: Fetcher = fetch,
): Promise<(displayName: string | null | undefined) => PricedFacts> {
  const doc = await cached(kv, ANTHROPIC_PRICING_URL, async () => {
    const markdown = await fetchText(ANTHROPIC_PRICING_URL, undefined, fetcher)
    const parsed = parseAnthropicPricing(markdown)
    assertParsed(parsed, 'anthropic pricing page')
    return {
      rates: Object.fromEntries(parsed),
      hash: await sha256Text(markdown),
      extractedAt: new Date().toISOString(),
    }
  })
  return (displayName) => {
    const row = doc.rates[(displayName ?? '').trim().toLowerCase()]
    const pricing = row
      ? compileTokenCard(row.rates, row.tiers, {
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
