/**
 * OpenRouter `pricing` listing → usage-bound token card.
 *
 * A listing is USD-per-unit strings (`{ prompt: "0.0000025", completion:
 * "0.00001", input_cache_read: "0.00000125", … }`). Every priced key becomes
 * a usage lever billed at its own rate; counts are disjoint (`input_tokens`
 * excludes the cached tokens billed at `input_cache_read`). `prompt` and
 * `completion` levers are required; `requests` defaults to 1, the rest to 0.
 *
 * `overrides` entries with `min_prompt_tokens` compile to rate tiers keyed on
 * total prompt tokens (input + cache read + cache writes). A tier applies
 * when the total is strictly greater than the threshold (OpenRouter's rule).
 */
import { compileTokenCard } from './token-card.ts'
import type { TokenRateTier } from './token-card.ts'
import type { RateCard } from './rate-card.schema.ts'

/** OpenRouter pricing key → the usage lever it prices. */
const LEVERS: Record<string, string> = {
  prompt: 'input_tokens',
  completion: 'output_tokens',
  input_cache_read: 'cache_read_tokens',
  input_cache_write: 'cache_write_tokens',
  input_cache_write_1h: 'cache_write_1h_tokens',
  internal_reasoning: 'reasoning_tokens',
  image: 'image_tokens',
  image_output: 'image_output_tokens',
  audio: 'audio_tokens',
  audio_output: 'audio_output_tokens',
  input_audio_cache: 'audio_cache_tokens',
  web_search: 'web_searches',
  request: 'requests',
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Numeric-string rates of one listing / override; `null` if any is unusable. */
function rates(entry: Record<string, unknown>): Record<string, number> | null {
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(entry)) {
    if (
      key === 'overrides' ||
      key === 'min_prompt_tokens' ||
      key.startsWith('utc_')
    )
      continue
    if (key === 'discount') continue
    const n =
      typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
    // "-1" is OpenRouter's variable-price router sentinel: not a price.
    if (!Number.isFinite(n) || n < 0) return null
    out[key] = n
  }
  return out
}

/** Listing keys → lever names, unmapped keys kept verbatim. */
function byLever(entry: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(entry).map(([key, rate]) => [LEVERS[key] ?? key, rate]),
  )
}

export function compileOpenRouterPricing(
  listing: unknown,
  source: RateCard['source'],
): RateCard | null {
  if (!isRecord(listing)) return null
  const base = rates(listing)
  if (!base || !('prompt' in base) || !('completion' in base)) return null

  // ponytail: time-window overrides (`utc_days`/`utc_start`/`utc_end`) need a
  // clock the card does not have; they are skipped, so the card quotes the
  // base (peak) rate. Add a usage-bound `utc_*` lever if off-peak quotes matter.
  const tiers: Array<TokenRateTier> = []
  for (const override of Array.isArray(listing.overrides)
    ? listing.overrides
    : []) {
    if (!isRecord(override) || typeof override.min_prompt_tokens !== 'number')
      continue
    const tier = rates(override)
    if (!tier) return null
    tiers.push({
      minPromptTokens: override.min_prompt_tokens,
      rates: byLever({ ...base, ...tier }),
    })
  }

  // All-zero (free / placeholder) listings price nothing.
  return compileTokenCard(byLever(base), tiers, source)
}
