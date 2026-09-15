import type { RateCard } from '../rate-card.schema.ts'

/**
 * https://openrouter.ai/api/v1/models, `openai/gpt-4o` pricing, read
 * 2026-09-15:
 *
 * > {"prompt":"0.0000025","completion":"0.00001","input_cache_read":"0.00000125"}
 *
 * USD per token. Token counts are disjoint: `input_tokens` excludes the
 * cached tokens billed at the cache-read rate.
 */
export const GPT_4O: RateCard = {
  inputs: {
    input_tokens: { param: 'input_tokens', bound: 'usage', kind: 'number' },
    output_tokens: { param: 'output_tokens', bound: 'usage', kind: 'number' },
    cache_read_tokens: {
      param: 'cache_read_tokens',
      bound: 'usage',
      kind: 'number',
      default: 0,
    },
  },
  tables: {
    rate: {
      prompt: 0.0000025,
      completion: 0.00001,
      input_cache_read: 0.00000125,
    },
  },
  price: {
    '+': [
      {
        '*': [
          { var: 'input_tokens' },
          { lookup: { table: 'rate', keys: ['prompt'] } },
        ],
      },
      {
        '*': [
          { var: 'output_tokens' },
          { lookup: { table: 'rate', keys: ['completion'] } },
        ],
      },
      {
        '*': [
          { var: 'cache_read_tokens' },
          { lookup: { table: 'rate', keys: ['input_cache_read'] } },
        ],
      },
    ],
  },
  examples: [
    {
      params: { input_tokens: 1_000_000, output_tokens: 0 },
      usd: 2.5,
      quote: '"prompt":"0.0000025" — 1M input tokens',
    },
    {
      params: { input_tokens: 0, output_tokens: 1_000_000 },
      usd: 10,
      quote: '"completion":"0.00001" — 1M output tokens',
    },
    {
      params: {
        input_tokens: 10_000,
        output_tokens: 2_000,
        cache_read_tokens: 40_000,
      },
      usd: 0.095,
      quote:
        '10k input + 40k cache read ("input_cache_read":"0.00000125") + 2k output',
    },
  ],
  source: {
    url: 'https://openrouter.ai/api/v1/models',
    hash: '57f5824a42922529afe86be0a55081918543804e38877a2e53a9554dc1c6865a',
    extractedAt: '2026-09-15T00:00:00Z',
  },
}
