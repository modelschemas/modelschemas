import { describe, expect, it } from 'vitest'
import { price } from './evaluate.ts'
import { GPT_4O } from './fixtures/gpt-4o.ts'
import { rateCardSchema } from './rate-card.schema.ts'
import { compileTokenCard } from './token-card.ts'

const source = GPT_4O.source

const compile = (
  base: Record<string, number>,
  tiers: Parameters<typeof compileTokenCard>[1] = [],
) => {
  const card = compileTokenCard(base, tiers, source)
  if (!card) throw new Error('did not compile')
  expect(rateCardSchema.safeParse(card).success).toBe(true)
  return card
}

describe('compileTokenCard', () => {
  it('prices each lever at its own rate', () => {
    const card = compile({
      input_tokens: 1.25 / 1e6,
      cache_read_tokens: 0.125 / 1e6,
      output_tokens: 10 / 1e6,
    })
    expect(
      price(card, {}, { input_tokens: 1e6, output_tokens: 0 }),
    ).toBeCloseTo(1.25, 9)
    expect(
      price(
        card,
        {},
        { input_tokens: 0, cache_read_tokens: 2e6, output_tokens: 1e6 },
      ),
    ).toBeCloseTo(10.25, 9)
  })

  it('re-quotes above a prompt-token threshold, cache reads included', () => {
    const card = compile({ input_tokens: 1.25e-6, output_tokens: 10e-6 }, [
      { minPromptTokens: 200_000, rates: { input_tokens: 2.5e-6 } },
    ])
    // At the threshold the base rate still applies (strictly greater wins).
    expect(price(card, {}, { input_tokens: 200_000, output_tokens: 0 })).toBe(
      0.25,
    )
    expect(price(card, {}, { input_tokens: 200_001, output_tokens: 0 })).toBe(
      0.5000025,
    )
    // A tier that re-quotes only the input keeps the base output rate.
    expect(price(card, {}, { input_tokens: 300_000, output_tokens: 1e6 })).toBe(
      10.75,
    )
  })

  it('counts extra prompt levers toward the tier', () => {
    const base = {
      input_tokens: 1e-6,
      audio_tokens: 2e-6,
      output_tokens: 1e-6,
    }
    const tiers = [
      {
        minPromptTokens: 128_000,
        rates: {
          input_tokens: 2e-6,
          audio_tokens: 4e-6,
          output_tokens: 2e-6,
        },
      },
    ]
    const withAudio = compileTokenCard(base, tiers, source, {
      extraPromptLevers: ['audio_tokens', 'audio_cache_tokens'],
    })
    const textOnly = compileTokenCard(base, tiers, source)
    if (!withAudio || !textOnly) throw new Error('did not compile')
    const usage = { input_tokens: 0, audio_tokens: 200_000, output_tokens: 0 }
    expect(price(withAudio, {}, usage)).toBeCloseTo(0.8, 9)
    expect(price(textOnly, {}, usage)).toBeCloseTo(0.4, 9)
  })

  it('requires token counts but defaults every other lever', () => {
    const card = compile({ input_tokens: 1e-6, output_tokens: 2e-6 })
    expect(() => price(card, {}, { input_tokens: 1 })).toThrow(
      expect.objectContaining({ code: 'bad-input' }),
    )
  })

  it('prices an output-less card (embeddings)', () => {
    const card = compile({ input_tokens: 0.02 / 1e6 })
    expect(price(card, {}, { input_tokens: 1e6 })).toBeCloseTo(0.02, 9)
  })

  it('is null when nothing is priced', () => {
    expect(compileTokenCard({}, [], source)).toBeNull()
    expect(
      compileTokenCard({ input_tokens: 0, output_tokens: 0 }, [], source),
    ).toBeNull()
    expect(compileTokenCard({ input_tokens: -1e-6 }, [], source)).toBeNull()
    expect(
      compileTokenCard({ input_tokens: Number.NaN }, [], source),
    ).toBeNull()
  })
})
