import { describe, expect, it } from 'vitest'
import { priceRequest, verifyExamples } from './evaluate.ts'
import { GPT_4O } from './fixtures/gpt-4o.ts'
import { NANO_BANANA_2 } from './fixtures/nano-banana-2.ts'
import { compileOpenRouterPricing } from './openrouter.ts'
import { rateCardSchema } from './rate-card.schema.ts'
import type { RateCard } from './rate-card.schema.ts'

const source = GPT_4O.source

const compile = (listing: unknown): RateCard => {
  const card = compileOpenRouterPricing(listing, source)
  if (!card) throw new Error('did not compile')
  expect(rateCardSchema.safeParse(card).success).toBe(true)
  return card
}

describe('priceRequest', () => {
  it('reads usage-bound levers from usage, not the request body', () => {
    expect(
      priceRequest(GPT_4O, {
        request: { input_tokens: 999_999_999, model: 'gpt-4o' },
        usage: { input_tokens: 1_000_000, output_tokens: 0 },
      }),
    ).toBe(2.5)
  })

  it('refuses a token card without usage', () => {
    expect(() =>
      priceRequest(GPT_4O, { request: { input_tokens: 1, output_tokens: 1 } }),
    ).toThrow(expect.objectContaining({ code: 'bad-input' }))
  })

  it('reads request-bound levers from the request body', () => {
    expect(
      priceRequest(NANO_BANANA_2, {
        request: { resolution: '4K' },
        usage: { resolution: '0.5K' },
      }),
    ).toBe(0.16)
  })
})

describe('compileOpenRouterPricing', () => {
  it('gpt-4o listing reproduces the hand card’s worked examples', () => {
    const card = compile({
      prompt: '0.0000025',
      completion: '0.00001',
      input_cache_read: '0.00000125',
    })
    const results = verifyExamples({ ...card, examples: GPT_4O.examples })
    expect(results.filter((r) => !r.ok)).toEqual([])
  })

  it('keeps extra keys as optional usage levers', () => {
    const card = compile({
      prompt: '0.000002',
      completion: '0.000012',
      image: '0.000002',
      audio: '0.000002',
      web_search: '0.014',
      internal_reasoning: '0.000012',
    })
    expect(Object.keys(card.inputs).sort()).toEqual([
      'audio_tokens',
      'image_tokens',
      'input_tokens',
      'output_tokens',
      'reasoning_tokens',
      'web_searches',
    ])
    const usage = { input_tokens: 1000, output_tokens: 1000 }
    expect(priceRequest(card, { usage })).toBeCloseTo(0.014, 9)
    expect(
      priceRequest(card, {
        usage: { ...usage, web_searches: 2, reasoning_tokens: 1000 },
      }),
    ).toBeCloseTo(0.014 + 0.028 + 0.012, 9)
  })

  it('compiles min_prompt_tokens overrides to tiers on total prompt tokens', () => {
    const card = compile({
      prompt: '0.0000001',
      completion: '0.0000004',
      input_cache_read: '0.00000001',
      overrides: [
        {
          min_prompt_tokens: 256000,
          prompt: '0.0000002',
          completion: '0.0000008',
        },
        {
          min_prompt_tokens: 32000,
          prompt: '0.00000015',
          completion: '0.0000006',
        },
      ],
    })
    const at = (input_tokens: number, cache_read_tokens = 0) =>
      priceRequest(card, {
        usage: { input_tokens, output_tokens: 0, cache_read_tokens },
      })
    expect(at(10_000)).toBeCloseTo(0.001, 9)
    expect(at(100_000)).toBeCloseTo(0.015, 9)
    expect(at(300_000)).toBeCloseTo(0.06, 9)
    // Cached tokens count toward the threshold; the tier keeps the base cache rate.
    expect(at(20_000, 20_000)).toBeCloseTo(0.003 + 0.0002, 9)
  })

  it.each<[string, unknown]>([
    ['Together-style all-zero listing', { prompt: '0', completion: '0' }],
    ['router variable-price sentinel', { prompt: '-1', completion: '-1' }],
    ['no completion rate', { prompt: '0.000001' }],
    ['non-numeric rate', { prompt: 'free', completion: '0' }],
    ['not an object', null],
  ])('%s does not compile', (_name, listing) => {
    expect(compileOpenRouterPricing(listing, source)).toBeNull()
  })
})
