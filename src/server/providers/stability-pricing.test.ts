import { describe, expect, it } from 'vitest'

import { compileUnitCard } from '@modelschemas/rate-card'

import { parseStabilityPricing } from './stability-pricing.ts'

/** Excerpt of https://docs.stability.ai/pricing.md (2026-10-19). */
const PAGE = String.raw`# Pricing

<Columns cols={2}>
  <Card title="How does pricing work?" icon="coins">
    API usage is based on credits. 1 credit = \$0.01.
  </Card>
</Columns>

### Generate

| Service | Description | Price (credits) |
| - | - | - |
| [Stable Image Ultra](/api-reference/generate/stable-image-ultra) | Flagship image service based on Stable Diffusion 3.5 Large, offering the highest quality and detail | 8 |
| [Stable Diffusion 3.5 Large](/api-reference/generate/stable-diffusion-35) | SD 3.5 is our most powerful 8 billion parameter base model with superior quality and prompt adherence | 6.5 |
| [SDXL 1.0](/api-reference/sdxl-10/text-to-image) | Legacy base model for straightforward image generation | From 0.9 |

### Upscale

| Service | Description | Price (credits) |
| - | - | - |
| [Fast Upscaler](/api-reference/upscale/fast) | Simple, low-cost upscaler to increase image resolution by 4, up to 4 megapixels | 2 |
`

const SOURCE = {
  url: 'https://docs.stability.ai/pricing.md',
  hash: 'c'.repeat(64),
  extractedAt: '2026-10-03T00:00:00.000Z',
}

describe('stability pricing page', () => {
  it('prices an exact credit count and leaves an inexact model null', () => {
    const rates = parseStabilityPricing(PAGE)
    expect(rates.get('Stable Image Ultra')).toBe(0.08)
    expect(rates.get('Stable Diffusion 3.5 Large')).toBeCloseTo(0.065)
    expect(rates.get('Fast Upscaler')).toBe(0.02)
    expect(
      compileUnitCard({ rates: rates.get('Stable Image Ultra') ?? 0 }, SOURCE),
    ).toMatchObject({ price: 0.08 })
    expect(rates.has('SDXL 1.0')).toBe(false)
    expect(rates.has('Service')).toBe(false)
    expect(rates.size).toBe(3)
  })

  it('prices nothing without the stated credit rate', () => {
    expect(
      parseStabilityPricing(PAGE.replace('1 credit', 'One credit')).size,
    ).toBe(0)
  })
})
