import { compileTokenCard, price, priceDetailed } from '@modelschemas/rate-card'
import { describe, expect, it } from 'vitest'

import { FIXTURE_CARDS } from '../../packages/rate-card/src/fixtures/index.ts'
import { compileSeedanceCard } from '../server/providers/byteplus-pricing.ts'
import { formFields, seedValues, toEstimateParts } from './rate-card-form.ts'

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
    const sent = (value: string) =>
      toEstimateParts(inputs, { image_urls: value }).request.image_urls
    expect(sent('3')).toEqual(['', '', ''])
    // Anything else goes through raw for the estimator to refuse — never a
    // guessed length, never a huge list built in memory.
    for (const bad of ['', 'abc', '-3', '2.7', '1e10', '5000']) {
      expect(sent(bad)).toBe(bad)
    }
    const card = { ...FIXTURE_CARDS['openai/gpt-4o']!, inputs, examples: [] }
    expect(() => price(card, { image_urls: sent('') })).toThrow(
      /expected a list/,
    )
  })

  it('leaves completion_tokens blank and prices 720p 5s from duration', () => {
    const card = compileSeedanceCard(
      {
        default: {
          '720p': { no_video: 10.7, video: 6.4 },
          '1080p': { no_video: 11.7, video: 7 },
        },
      },
      {
        url: 'https://example.test/pricing',
        hash: 'a'.repeat(64),
        extractedAt: '2026-10-04T00:00:00.000Z',
      },
      {
        model: {
          fps: 24,
          dims: {
            '720p': { '16:9': { w: 1280, h: 720 } },
            '1080p': { '16:9': { w: 1920, h: 1080 } },
          },
        },
        url: 'https://example.test/guide',
        hash: 'b'.repeat(64),
      },
    )
    if (!card) throw new Error('no card')
    const values = seedValues(card)
    expect(values.completion_tokens).toBe('')
    expect(values.duration).toBe('5')
    expect(values.ratio).toBe('16:9')
    expect(values.resolution).toBe('720p')
    expect(formFields(card.inputs).map((field) => field.input.param)).toEqual([
      'service_tier',
      'draft',
      'ratio',
      'duration',
      'completion_tokens',
      'resolution',
      'input_video',
    ])
    const { request, usage } = toEstimateParts(card.inputs, values)
    expect(usage).toEqual({ input_video: false })
    expect(request).toMatchObject({
      resolution: '720p',
      ratio: '16:9',
      duration: '5',
    })
    expect(request).not.toHaveProperty('completion_tokens')
    const result = priceDetailed(card, request, usage)
    expect(result.estimated).toEqual(['completion_tokens'])
    expect(result.usd).toBeCloseTo(1.156, 2)
  })

  it('seeds a preset-name example to that preset size', () => {
    const card = {
      inputs: {
        image_size: {
          param: 'image_size',
          kind: 'dimensions' as const,
          presets: {
            square_hd: [1024, 1024] as [number, number],
            landscape: [1536, 1024] as [number, number],
          },
        },
      },
      examples: [{ params: { image_size: 'landscape' }, usd: 1, quote: 'q' }],
    }
    expect(seedValues(card).image_size).toEqual({
      width: '1536',
      height: '1024',
    })
  })

  // The loader quotes the seeded fields, so the first number on the page
  // must reproduce the example those fields came from.
  it.each(Object.entries(FIXTURE_CARDS))(
    '%s: seeded quote reproduces its example',
    (_id, card) => {
      const params = Object.values(card.inputs).map((input) => input.param)
      const covered = (example: (typeof card.examples)[number]) =>
        params.filter((param) => param in example.params).length
      const best = card.examples.reduce((top, example) =>
        covered(example) > covered(top) ? example : top,
      )
      expect(Math.abs(quote(card) - best.usd)).toBeLessThanOrEqual(
        best.usd * 0.01,
      )
    },
  )
})
