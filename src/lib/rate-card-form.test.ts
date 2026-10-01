import { compileTokenCard, price } from '@modelschemas/rate-card'
import { describe, expect, it } from 'vitest'

import { FIXTURE_CARDS } from '../../packages/rate-card/src/fixtures/index.ts'
import { seedValues, toEstimateParts } from './rate-card-form.ts'

const quote = (
  card: (typeof FIXTURE_CARDS)[string],
  values = seedValues(card),
) => {
  const { request, usage } = toEstimateParts(card.inputs, values)
  return price(card, request, usage)
}

describe('rate card form', () => {
  it('seeds a token card from the example that covers the most inputs', () => {
    const card = FIXTURE_CARDS['openai/gpt-4o']!
    expect(seedValues(card)).toEqual({
      input_tokens: '10000',
      output_tokens: '2000',
      cache_read_tokens: '40000',
    })
    expect(quote(card)).toBeCloseTo(0.095)
  })

  it('defaults token counts to 1M when no example matches', () => {
    const source = FIXTURE_CARDS['openai/gpt-4o']!.source
    const card = compileTokenCard(
      { input_tokens: 1e-6, output_tokens: 2e-6 },
      [
        {
          minPromptTokens: 200_000,
          rates: { input_tokens: 4e-6, output_tokens: 8e-6 },
        },
      ],
      source,
    )!
    const values = seedValues(card)
    expect(values.input_tokens).toBe('1000000')
    // 1M prompt tokens sits above the 200k tier: the tier rate applies.
    expect(quote(card, values)).toBeCloseTo(4 + 8)
    expect(quote(card, { ...values, input_tokens: '100000' })).toBeCloseTo(
      0.1 + 2,
    )
  })

  it('prices a dimensions card and re-quotes on edit', () => {
    const card = FIXTURE_CARDS['dola-seedream-5-0-pro-260628']!
    const values = seedValues(card)
    expect(values.image_size).toEqual({ width: '2048', height: '2048' })
    expect(quote(card, values)).toBeCloseTo(0.18)
    expect(
      quote(card, { ...values, image_size: { width: '1024', height: '1024' } }),
    ).toBeCloseTo(0.09)
  })

  it('turns a count field into a list of that length', () => {
    const inputs = {
      image_urls: { param: 'image_urls', kind: 'count' as const },
    }
    expect(toEstimateParts(inputs, { image_urls: '3' }).request).toEqual({
      image_urls: ['', '', ''],
    })
  })
})
