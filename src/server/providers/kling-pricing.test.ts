import { describe, expect, it } from 'vitest'

import { compileUnitCard } from '@modelschemas/rate-card'

import { parseKlingPricing } from './kling-pricing.ts'

/** Excerpt of the English table embedded in https://kling.ai/dev/pricing. */
const PAGE = JSON.stringify({
  en: {
    newImageApi: {
      main: {
        list: [
          {
            table: {
              data: [
                {
                  model: 'Kling Image O1',
                  price: '8 Units ($0.028) / image',
                  quality: '1K, 2K',
                },
                {
                  model: 'Kling Image 2.1',
                  price: [
                    '4 Units ($0.014) / image',
                    '8 Units ($0.028) / image',
                  ],
                  quality: ['1K, 2K', '1K, 2K'],
                },
              ],
            },
          },
        ],
      },
    },
    newVideoApi: {
      main: {
        list: [
          {
            table: {
              data: [
                {
                  model: 'Kling 3.0',
                  spec: 'Per second',
                  function: [
                    'No Native Audio',
                    'With Native Audio x No Voice Control',
                  ],
                  p720: ['0.6 Units ($0.084) /s', '0.9 Units ($0.126) /s'],
                  p1080: ['0.8 Units ($0.112) /s', '1.2 Units ($0.168) /s'],
                  p4k: ['3.0 Units ($0.42) /s', '3.0 Units ($0.42) /s'],
                },
              ],
            },
          },
        ],
      },
    },
  },
})

const SOURCE = {
  url: 'https://kling.ai/dev/pricing',
  hash: 'b'.repeat(64),
  extractedAt: '2026-10-03T00:00:00.000Z',
}

describe('kling pricing page', () => {
  it('prices a single-amount model and leaves an unpriced id null', () => {
    const rates = parseKlingPricing(PAGE)
    const image = rates.get('kling-image-o1')
    expect(image?.rates).toBe(0.028)
    expect(image ? compileUnitCard(image, SOURCE) : null).toMatchObject({
      price: { '*': [{ var: 'n' }, 0.028] },
    })
    const video = rates.get('kling-v3')
    expect(video?.rates).toEqual({
      off: { std: 0.084, pro: 0.112 },
      on: { std: 0.126, pro: 0.168 },
    })
    expect(video ? compileUnitCard(video, SOURCE) : null).not.toBeNull()
    expect(rates.has('kling-v2-1')).toBe(false)
    expect(rates.has('kling-v1')).toBe(false)
  })
})
