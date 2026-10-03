import { describe, expect, it } from 'vitest'

import { compileUnitCard } from '@modelschemas/rate-card'

import { parseStabilityPricing } from './stability-pricing.ts'

/** Excerpt of the pricing-app bundle at https://platform.stability.ai/pricing. */
const PAGE = `API usage is based on credits. 1 credit = $0.01.
{id:"generate-ultra",service:"Stable Image Ultra",description:"Flagship image service",price:"8"}
{id:"generate-sdxl-1-0",service:"SDXL 1.0",description:"Legacy base model",price:"From 0.9"}
{id:"upscale-fast",service:"Fast Upscaler",description:"Increase resolution by 4",price:"2"}
`

const SOURCE = {
  url: 'https://platform.stability.ai/pricing',
  hash: 'c'.repeat(64),
  extractedAt: '2026-10-03T00:00:00.000Z',
}

describe('stability pricing page', () => {
  it('prices an exact credit count and leaves an inexact model null', () => {
    const rates = parseStabilityPricing(PAGE)
    expect(rates.get('generate-ultra')).toBe(0.08)
    expect(
      compileUnitCard({ rates: rates.get('generate-ultra') ?? 0 }, SOURCE),
    ).toMatchObject({ price: 0.08 })
    expect(rates.has('generate-sdxl-1-0')).toBe(false)
    expect(rates.has('stable-diffusion-xl-1024-v1-0')).toBe(false)
  })
})
