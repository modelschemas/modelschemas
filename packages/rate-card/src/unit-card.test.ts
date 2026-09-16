import { describe, expect, it } from 'vitest'
import { price } from './evaluate.ts'
import { GPT_4O } from './fixtures/gpt-4o.ts'
import { rateCardSchema } from './rate-card.schema.ts'
import { compileUnitCard } from './unit-card.ts'
import type { UnitCardSpec } from './unit-card.ts'

const source = GPT_4O.source

const compile = (spec: UnitCardSpec) => {
  const card = compileUnitCard(spec, source)
  if (!card) throw new Error('did not compile')
  expect(rateCardSchema.safeParse(card).success).toBe(true)
  return card
}

describe('compileUnitCard', () => {
  it('prices a flat per-unit rate the caller measures', () => {
    const card = compile({
      quantity: { param: 'audio_seconds', bound: 'usage' },
      rates: 0.006 / 60,
    })
    expect(price(card, {}, { audio_seconds: 600 })).toBeCloseTo(0.06, 9)
    // No default: a duration nobody stated is not guessed at.
    expect(() => price(card)).toThrow(
      expect.objectContaining({ code: 'bad-input' }),
    )
  })

  it('looks the rate up by a request field', () => {
    const card = compile({
      quantity: { param: 'seconds', bound: 'request' },
      keys: [{ param: 'size', values: ['720x1280', '1792x1024'] }],
      rates: { '720x1280': 0.3, '1792x1024': 0.5 },
    })
    expect(price(card, { seconds: 8, size: '1792x1024' })).toBe(4)
    expect(() => price(card, { seconds: 8, size: '3840x2160' })).toThrow(
      expect.objectContaining({ code: 'bad-input' }),
    )
  })

  it('looks the rate up by two dimensions', () => {
    const card = compile({
      keys: [
        { param: 'quality', values: ['low', 'medium'], default: 'low' },
        { param: 'resolution', values: ['1k', '2k'], default: '1k' },
      ],
      rates: {
        low: { '1k': 0.04, '2k': 0.06 },
        medium: { '1k': 0.06, '2k': 0.08 },
      },
    })
    expect(price(card, {})).toBe(0.04)
    expect(price(card, { quality: 'medium', resolution: '2k' })).toBe(0.08)
  })

  it('is null when a rate is missing, zero or uncovered', () => {
    expect(compileUnitCard({ rates: 0 }, source)).toBeNull()
    expect(
      compileUnitCard(
        {
          keys: [{ param: 'size', values: ['720p', '1080p'] }],
          rates: { '720p': 0.1 },
        },
        source,
      ),
    ).toBeNull()
    expect(
      compileUnitCard(
        {
          keys: [{ param: 'size', values: ['720p'], default: '4k' }],
          rates: { '720p': 0.1 },
        },
        source,
      ),
    ).toBeNull()
  })
})
