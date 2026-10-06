import { describe, expect, it } from 'vitest'

import {
  compileReplicateBilling,
  replicateBillingFromHtml,
  replicatePagePricing,
} from './replicate-pricing.ts'

const SOURCE = {
  url: 'https://replicate.com/black-forest-labs/flux-schnell',
  hash: 'abc',
  extractedAt: '2026-10-03T00:00:00.000Z',
}

describe('replicate prediction prices', () => {
  it('compiles a per-thousand output image price', () => {
    const card = compileReplicateBilling(
      {
        current_tiers: [
          {
            criteria: [],
            prices: [
              {
                metric: 'image_output_count',
                price: '$3',
                title: 'per thousand output images',
                type: 'per-unit',
              },
            ],
          },
        ],
      },
      SOURCE,
    )
    expect(card?.price).toEqual({
      '*': [{ var: 'output_images' }, 3 / 1000],
    })
    expect(card?.inputs.output_images).toMatchObject({ bound: 'usage' })
  })

  it('compiles input and output token prices', () => {
    const card = compileReplicateBilling(
      {
        current_tiers: [
          {
            criteria: [],
            prices: [
              {
                metric: 'token_output_count',
                price: '$0.01',
                title: 'per thousand output tokens',
                type: 'per-unit',
              },
              {
                metric: 'token_input_count',
                price: '$3.75',
                title: 'per million input tokens',
                type: 'per-unit',
              },
            ],
          },
        ],
      },
      SOURCE,
    )
    expect(card?.tables.rate).toEqual({
      base: {
        output_tokens: 0.01 / 1000,
        input_tokens: 3.75 / 1_000_000,
      },
    })
  })

  it('compiles a resolution tier as a usage-bound lookup', () => {
    const card = compileReplicateBilling(
      {
        current_tiers: [
          {
            criteria: [
              { title: 'target resolution', type: 'equals', value: '480p' },
            ],
            prices: [
              {
                metric: 'video_output_duration_seconds',
                price: '$0.03',
                title: 'per second of output video',
                type: 'per-unit',
              },
            ],
          },
          {
            criteria: [
              { title: 'target resolution', type: 'equals', value: '720p' },
            ],
            prices: [
              {
                metric: 'video_output_duration_seconds',
                price: '$0.06',
                title: 'per second of output video',
                type: 'per-unit',
              },
            ],
          },
        ],
      },
      SOURCE,
    )
    expect(card?.tables.rate).toEqual({ '480p': 0.03, '720p': 0.06 })
    expect(card?.inputs.target_resolution).toMatchObject({
      bound: 'usage',
      values: ['480p', '720p'],
    })
  })

  it('leaves an empty billing config and an unknown unit null', () => {
    expect(compileReplicateBilling({ current_tiers: [] }, SOURCE)).toBeNull()
    expect(
      compileReplicateBilling(
        {
          current_tiers: [
            {
              criteria: [],
              prices: [
                {
                  metric: 'image_output_count',
                  price: '$1',
                  title: 'per request',
                  type: 'per-unit',
                },
              ],
            },
          ],
        },
        SOURCE,
      ),
    ).toBeNull()
  })

  it('reads billingConfig from the model page and ignores a page with none', () => {
    const html = `<section id="pricing"><script type="application/json">{"billingConfig":{"current_tiers":[{"criteria":[],"prices":[{"metric":"image_output_count","price":"$0.04","title":"per output image","type":"per-unit"}]}]}}</script>`
    expect(replicateBillingFromHtml(html)?.current_tiers).toHaveLength(1)
    const priced = replicatePagePricing(html, SOURCE)
    expect(priced.pricing).toMatchObject({
      price: { '*': [{ var: 'output_images' }, 0.04] },
    })
    expect(replicatePagePricing('<p>no price</p>', SOURCE)).toEqual({})
  })
})

describe('replicate prompt-length token tiers', () => {
  // https://replicate.com/google/gemini-3-pro billingConfig.
  const tier = (
    range: [number | null, number | null],
    subtype: string,
    input: string,
    output: string,
  ) => ({
    criteria: [{ title: 'input token', type: 'range', subtype, value: range }],
    prices: [
      {
        metric: 'token_input_count',
        price: input,
        title: 'per million input tokens',
        type: 'per-unit',
      },
      {
        metric: 'token_output_count',
        price: output,
        title: 'per thousand output tokens',
        type: 'per-unit',
      },
    ],
  })
  const low = tier([null, 200000], 'open-closed', '$2', '$0.012')
  const high = tier([200000, null], 'open', '$4', '$0.018')

  it('compiles the base tier and the re-quote above the threshold', () => {
    const card = compileReplicateBilling({ current_tiers: [low, high] }, SOURCE)
    expect(card?.tables.rate).toEqual({
      base: { input_tokens: 2e-6, output_tokens: 0.012 / 1000 },
      '200000': { input_tokens: 4e-6, output_tokens: 0.018 / 1000 },
    })
  })

  it('refuses any other range shape', () => {
    const compile = (...tiers: Array<ReturnType<typeof tier>>) =>
      compileReplicateBilling({ current_tiers: tiers }, SOURCE)
    // One tier alone, a gap between the tiers, a closed upper tier.
    expect(compile(low)).toBeNull()
    expect(compile(high)).toBeNull()
    expect(compile(low, tier([256000, null], 'open', '$4', '$0.018'))).toBe(
      null,
    )
    expect(
      compile(low, tier([200000, 400000], 'open-closed', '$4', '$0.018')),
    ).toBeNull()
    expect(compile(low, { ...high, criteria: [] })).toBeNull()
    // A range over something other than prompt tokens.
    const seconds = structuredClone(high)
    if (seconds.criteria[0]) seconds.criteria[0].title = 'output second'
    expect(compile(low, seconds)).toBeNull()
    // A tier that prices only input tokens.
    expect(compile(low, { ...high, prices: high.prices.slice(0, 1) })).toBe(
      null,
    )
  })
})
