import { describe, expect, it } from 'vitest'

import { price, verifyExamples } from '@modelschemas/rate-card'
import type { RateCard } from '@modelschemas/rate-card'

import { priceFalNamedSection } from './fal-unit-rate.ts'
import { compileFalTokenCard } from './fal-token-rate.ts'

const SOURCE: RateCard['source'] = {
  url: 'https://fal.ai/models/fal-ai/bytedance/seed/v2/mini/llms.txt',
  hash: 'a'.repeat(64),
  extractedAt: '2026-10-07T00:00:00.000Z',
}

/** Seed 2.0 Mini, https://fal.ai/models/fal-ai/bytedance/seed/v2/mini/llms.txt checked 2026-10-07. */
const SEED = `Your request will cost **$0.0001** per 1000 units. For inputs under 128k tokens, the units per input token is 1. For inputs of over 128k tokens, 2 units will be charged per token. Similarly, each output token costs 4 units, provided the total output length (reasoning + output) is under 128k tokens, and 8 units per token otherwise.

For more details, see [fal.ai pricing](https://fal.ai/pricing).`

/** Nemotron 3 Nano Omni, https://fal.ai/models/nvidia/nemotron-3-nano-omni/llms.txt checked 2026-10-07. */
const NEMOTRON = `- **Price**: $0.01 per 1000 tokens

For more details, see [fal.ai pricing](https://fal.ai/pricing).`

function base(card: RateCard | null): Record<string, number> | null {
  const rate = card?.tables.rate
  if (rate === undefined || typeof rate === 'number') return null
  const row = rate.base
  if (row === undefined || typeof row === 'number') return null
  return row as Record<string, number>
}

describe('compileFalTokenCard', () => {
  it('compiles the unit schedule as input and output token rates', () => {
    const card = compileFalTokenCard(`## Pricing\n\n${SEED}`, SOURCE)
    const perUnit = 0.0001 / 1000
    expect(base(card)).toEqual({
      input_tokens: perUnit,
      output_tokens: perUnit * 4,
    })
    expect(card && verifyExamples(card).every((result) => result.ok)).toBe(true)
    // Exactly 128k is not "over", so it stays on the under rate.
    expect(
      card && price(card, {}, { input_tokens: 128_000, output_tokens: 0 }),
    ).toBeCloseTo(128_000 * perUnit, 10)
    expect(
      card && price(card, {}, { input_tokens: 128_001, output_tokens: 0 }),
    ).toBeCloseTo(128_001 * perUnit * 2, 10)
    // Output crosses on its own length, not because the prompt did.
    expect(
      card && price(card, {}, { input_tokens: 1, output_tokens: 128_001 }),
    ).toBeCloseTo(perUnit + 128_001 * perUnit * 8, 10)
  })

  it('bills one undifferentiated per-token price on input and output', () => {
    const card = compileFalTokenCard(NEMOTRON, {
      ...SOURCE,
      url: 'https://fal.ai/models/nvidia/nemotron-3-nano-omni/llms.txt',
    })
    expect(base(card)).toEqual({
      input_tokens: 0.01 / 1000,
      output_tokens: 0.01 / 1000,
    })
    expect(
      card && price(card, {}, { input_tokens: 412, output_tokens: 87 }),
    ).toBeCloseTo(((412 + 87) / 1000) * 0.01, 10)
  })

  it('returns null unless the section is one of those two shapes', () => {
    const none = [
      '',
      'You will be charged based on the number of input and output tokens.\n\nFor more details, see [fal.ai pricing](https://fal.ai/pricing).',
      '- **Price**: $0.001 per 1\n\nFor more details, see [fal.ai pricing](https://fal.ai/pricing).',
      '- **Price**: $0.04 per megapixels',
      '- **Price**: $0.01 per 1000 output tokens',
      'Your request will cost **$0.0001** per 1000 units. Input is 1 unit and output is 4.',
      `${SEED}\nPeak price is **$0.0002** per 1000 units.`,
      '- **Price**: $0.01 per 1000 tokens. An additional $0.02 is charged for search.',
    ]
    for (const section of none) {
      expect(compileFalTokenCard(section, SOURCE), section).toBeNull()
    }
  })
})

describe('priceFalNamedSection token fallthrough', () => {
  it('keeps a single image rate and compiles a token section the unit parser drops', () => {
    const image = priceFalNamedSection(
      'Your request will cost **$0.08** per image.',
      new Set(),
      SOURCE,
    )
    expect(image?.inputs.images).toMatchObject({ bound: 'usage' })
    expect(base(image)).toBeNull()

    const seed = priceFalNamedSection(SEED, new Set(), SOURCE)
    expect(base(seed)?.input_tokens).toBe(0.0001 / 1000)
    expect(base(seed)?.output_tokens).toBe((0.0001 / 1000) * 4)
  })
})
