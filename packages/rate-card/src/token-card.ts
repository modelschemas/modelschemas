/**
 * Per-token rate sheet → usage-bound token card.
 *
 * The shape every host publishes: a rate per lever (`input_tokens`,
 * `output_tokens`, cache reads/writes, media tokens), optionally re-quoted
 * above a prompt-size threshold. Counts are disjoint — `input_tokens`
 * excludes tokens billed at `cache_read_tokens`. `input_tokens` and
 * `output_tokens` are required when priced; `requests` defaults to 1, every
 * other lever to 0, so a caller only supplies what it used.
 *
 * `compileOpenRouterPricing` maps OpenRouter's listing keys onto these
 * levers; the native providers build the rate map from their own docs.
 */
import type { Expr, RateCard, Table } from './rate-card.schema.ts'

/** Levers a tier threshold counts as prompt tokens. */
const PROMPT_LEVERS = [
  'input_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
  'cache_write_1h_tokens',
]

const REQUIRED = new Set(['input_tokens', 'output_tokens'])

/** A re-quote that applies above `minPromptTokens` prompt tokens. */
export interface TokenRateTier {
  minPromptTokens: number
  /** Full rate map at this tier (missing levers fall back to the base). */
  rates: Record<string, number>
}

function usable(rates: Record<string, number>): boolean {
  return Object.values(rates).every((n) => Number.isFinite(n) && n >= 0)
}

/**
 * `null` when nothing is priced: an empty, negative/NaN, or all-zero rate
 * map is "unknown", never a free card.
 *
 * `extraPromptLevers` join the threshold sum. The default set is text and
 * cache tokens; a host whose prompt length also counts audio passes those
 * levers here so other hosts stay on the default.
 */
export function compileTokenCard(
  base: Record<string, number>,
  tiers: Array<TokenRateTier>,
  source: RateCard['source'],
  options?: { extraPromptLevers?: ReadonlyArray<string> },
): RateCard | null {
  if (Object.keys(base).length === 0 || !usable(base)) return null
  if (Object.values(base).every((n) => n === 0)) return null
  if (tiers.some((tier) => !usable(tier.rates))) return null

  const sorted = [...tiers].sort(
    (a, b) => b.minPromptTokens - a.minPromptTokens,
  )
  const levers = [
    ...new Set([base, ...sorted.map((t) => t.rates)].flatMap(Object.keys)),
  ]
  const promptTotal: Expr = {
    '+': [...PROMPT_LEVERS, ...(options?.extraPromptLevers ?? [])]
      .filter((lever, index, all) => all.indexOf(lever) === index)
      .filter((lever) => levers.includes(lever))
      .map((lever) => ({ var: lever })),
  }
  // Highest matching threshold wins; at or below every threshold is base.
  const tierKey: Expr =
    sorted.length === 0
      ? 'base'
      : {
          if: [
            ...sorted.flatMap((tier): Expr[] => [
              { '>': [promptTotal, tier.minPromptTokens] },
              String(tier.minPromptTokens),
            ]),
            'base',
          ],
        }

  const table: Table = { base }
  for (const tier of sorted) {
    table[String(tier.minPromptTokens)] = { ...base, ...tier.rates }
  }

  return {
    inputs: Object.fromEntries(
      levers.map((lever) => [
        lever,
        {
          param: lever,
          bound: 'usage',
          kind: 'number',
          ...(!REQUIRED.has(lever) && {
            default: lever === 'requests' ? 1 : 0,
          }),
        },
      ]),
    ),
    tables: { rate: table },
    price: {
      '+': levers.map(
        (lever): Expr => ({
          // A zero count skips the lookup, so a lever a tier leaves unpriced
          // refuses only when it is actually used.
          if: [
            { '>': [{ var: lever }, 0] },
            {
              '*': [
                { var: lever },
                { lookup: { table: 'rate', keys: [tierKey, lever] } },
              ],
            },
            0,
          ],
        }),
      ),
    },
    examples: [],
    source,
  }
}
