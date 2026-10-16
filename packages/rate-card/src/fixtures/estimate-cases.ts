/**
 * One conformance suite for the evaluator. Each case runs through
 * `evaluateCard` in the package (`evaluator.test.ts`), through the built
 * package as it ships to npm (`scripts/npm-pack.test.ts`), and through
 * `POST /v1/estimate` (`src/server/estimate.worker.test.ts`). All three
 * must give `expected` (`amount`, `currency`, `estimated`). The route
 * also returns `usd`, `cardSource`, `defaulted`, and `ignored`. Add a
 * case here when the evaluator or the route changes what it returns.
 */
import type { RateCard } from '../card.ts'
import type { RateCardErrorCode } from '../evaluate.ts'
import type { CardEvaluation } from '../evaluator.ts'
import { compileTokenCard } from '../token-card.ts'
import { GPT_4O } from './gpt-4o.ts'
import { KLING_V3_PRO_IMAGE_TO_VIDEO } from './kling-v3-pro-image-to-video.ts'

export type EstimateCase = {
  name: string
  card: RateCard
  request?: Record<string, unknown>
  usage?: Record<string, unknown>
  /** The evaluation, or the package error code and the API error code. */
  expected: CardEvaluation | { error: RateCardErrorCode; apiError: string }
}

const source: RateCard['source'] = {
  url: 'https://example.com/pricing',
  hash: 'a'.repeat(64),
  extractedAt: '2026-10-01T00:00:00Z',
}

function tokenCard(rates: Record<string, number>, currency?: string): RateCard {
  const card = compileTokenCard(rates, [], source, { currency })
  if (!card) throw new Error('fixture rates price nothing')
  return card
}

/** USD per token. */
const GPT_5 = tokenCard({
  input_tokens: 1.25 / 1e6,
  cache_read_tokens: 0.125 / 1e6,
  output_tokens: 10 / 1e6,
})

const CLAUDE = tokenCard({
  input_tokens: 3 / 1e6,
  cache_read_tokens: 0.3 / 1e6,
  cache_write_tokens: 3.75 / 1e6,
  cache_write_1h_tokens: 6 / 1e6,
  output_tokens: 15 / 1e6,
})

const NO_CACHE_RATE = tokenCard({
  input_tokens: 1 / 1e6,
  output_tokens: 2 / 1e6,
})

/** Yuan per token, wrapped as `{ currency: ['CNY', expr] }`. */
const KIMI_CNY = tokenCard(
  { input_tokens: 20 / 1e6, output_tokens: 100 / 1e6 },
  'CNY',
)

/** `tokens` is estimated from `seconds` when the caller omits it. */
const ESTIMATED_TOKENS: RateCard = {
  inputs: {
    resolution: { param: 'resolution', kind: 'enum', values: ['480p'] },
    tokens: {
      param: 'tokens',
      bound: 'usage',
      kind: 'number',
      estimate: {
        inputs: { seconds: { param: 'seconds', kind: 'number' } },
        value: {
          '*': [
            { var: 'seconds' },
            { lookup: { table: 'per_second', keys: [{ var: 'resolution' }] } },
          ],
        },
        source: { url: 'https://example.com/guide', hash: 'b'.repeat(64) },
      },
    },
  },
  tables: { per_second: { '480p': 1000 } },
  price: { '*': [{ var: 'tokens' }, 0.001] },
  examples: [],
  source,
}

// (10000 - 4000) × 1.25 + 4000 × 0.125 + 1050 × 10 = 18500 per million.
// Counting the 4000 cached tokens at the input rate too gives 0.0235.
const GPT_5_CACHED = { amount: 0.0185, currency: 'USD', estimated: [] }

export const ESTIMATE_CASES: readonly EstimateCase[] = [
  {
    name: 'card levers on a USD token card',
    card: GPT_4O,
    usage: { input_tokens: 1000, output_tokens: 500, cache_read_tokens: 2000 },
    expected: { amount: 0.01, currency: 'USD', estimated: [] },
  },
  {
    name: 'OpenAI Responses usage counts cached tokens once',
    card: GPT_5,
    usage: {
      input_tokens: 10000,
      input_tokens_details: { cached_tokens: 4000 },
      output_tokens: 1050,
      output_tokens_details: { reasoning_tokens: 500 },
      total_tokens: 11050,
    },
    expected: GPT_5_CACHED,
  },
  {
    name: 'OpenAI Chat Completions usage counts cached tokens once',
    card: GPT_5,
    usage: {
      prompt_tokens: 10000,
      prompt_tokens_details: { cached_tokens: 4000 },
      completion_tokens: 1050,
      completion_tokens_details: { reasoning_tokens: 500 },
      total_tokens: 11050,
    },
    expected: GPT_5_CACHED,
  },
  {
    name: 'Gemini usageMetadata bills thoughts as output',
    card: GPT_5,
    usage: {
      promptTokenCount: 10000,
      cachedContentTokenCount: 4000,
      candidatesTokenCount: 550,
      thoughtsTokenCount: 500,
      totalTokenCount: 11050,
    },
    expected: GPT_5_CACHED,
  },
  {
    // 1000 × 3 + 2000 × 0.3 + 1000 × 3.75 + 500 × 6 + 200 × 15 per million.
    name: 'Anthropic usage splits cache writes by TTL',
    card: CLAUDE,
    usage: {
      input_tokens: 1000,
      cache_read_input_tokens: 2000,
      cache_creation_input_tokens: 1500,
      cache_creation: {
        ephemeral_5m_input_tokens: 1000,
        ephemeral_1h_input_tokens: 500,
      },
      output_tokens: 200,
    },
    expected: { amount: 0.01335, currency: 'USD', estimated: [] },
  },
  {
    name: 'a currency-wrapped card prices in its own currency',
    card: KIMI_CNY,
    usage: { input_tokens: 1000, output_tokens: 1000 },
    expected: { amount: 0.12, currency: 'CNY', estimated: [] },
  },
  {
    name: 'a request-bound card reads the request body',
    card: KLING_V3_PRO_IMAGE_TO_VIDEO,
    request: { duration: '10', generate_audio: false, prompt: 'a red fox' },
    expected: { amount: 1.12, currency: 'USD', estimated: [] },
  },
  {
    name: 'an omitted input with a published estimate is named',
    card: ESTIMATED_TOKENS,
    request: { resolution: '480p', seconds: 2 },
    expected: { amount: 2, currency: 'USD', estimated: ['tokens'] },
  },
  {
    name: 'a usage key the card does not read is refused',
    card: GPT_4O,
    usage: { input_tokens: 10, output_tokens: 10, reasoning_tokens: 5 },
    expected: { error: 'unknown-usage-key', apiError: 'unknown_usage_key' },
  },
  {
    name: 'cached tokens on a card with no cache rate are refused',
    card: NO_CACHE_RATE,
    usage: {
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 40 },
      output_tokens: 10,
    },
    expected: { error: 'unknown-usage-key', apiError: 'unknown_usage_key' },
  },
  {
    name: 'native fields mixed with card levers are refused',
    card: GPT_5,
    usage: { prompt_tokens: 100, completion_tokens: 10, output_tokens: 10 },
    expected: { error: 'mixed-usage', apiError: 'mixed_usage' },
  },
  {
    name: 'a required usage lever that is missing is refused',
    card: GPT_4O,
    usage: { input_tokens: 100 },
    expected: { error: 'bad-input', apiError: 'unbound_input' },
  },
]

/**
 * A run in the shape of `expected`: the amount rounded to 1e-12 so a
 * hand-written decimal compares exactly, or the thrown `RateCardError`'s
 * code. Checks `code`, not `instanceof`, so a built copy of the package
 * compares the same.
 */
export function settle(
  run: () => CardEvaluation,
): CardEvaluation | { error: string } {
  try {
    const result = run()
    return { ...result, amount: Math.round(result.amount * 1e12) / 1e12 }
  } catch (error) {
    if (error instanceof Error && 'code' in error) {
      return { error: String(error.code) }
    }
    throw error
  }
}

/** What `settle` must return for this case. */
export const packageExpected = ({
  expected,
}: EstimateCase): CardEvaluation | { error: string } =>
  'error' in expected ? { error: expected.error } : expected
