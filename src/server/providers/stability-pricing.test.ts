import { describe, expect, it, vi } from 'vitest'

import { compileUnitCard } from '@modelschemas/rate-card'

import type { cachedDocs } from './model-facts.ts'
import {
  parseStabilityPricing,
  stabilityModelPricing,
} from './stability-pricing.ts'

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
    expect(rates.get('Stable Image Ultra')).toBeCloseTo(0.08)
    expect(rates.get('Stable Diffusion 3.5 Large')).toBeCloseTo(0.065)
    expect(rates.get('Fast Upscaler')).toBeCloseTo(0.02)
    expect(
      compileUnitCard({ rates: rates.get('Stable Image Ultra') ?? 0 }, SOURCE),
    ).toMatchObject({ price: 0.08 })
    expect(rates.has('SDXL 1.0')).toBe(false)
    expect(rates.has('Service')).toBe(false)
    expect(rates.size).toBe(3)
  })

  it('reads only tables priced in credits', () => {
    const page = `${PAGE}
| Pack | Description | Price (USD) |
| - | - | - |
| Starter | 1,000 credits | 10 |
`
    expect(parseStabilityPricing(page).has('Starter')).toBe(false)
    expect(parseStabilityPricing(page).size).toBe(3)
  })

  it('refuses a service the page prices twice', () => {
    const page = `${PAGE}
| Service | Description | Price (credits) |
| - | - | - |
| [Fast Upscaler](/api-reference/upscale/fast) | Again | 3 |
`
    expect(() => parseStabilityPricing(page)).toThrow(
      'stability pricing: Fast Upscaler has two prices',
    )
  })

  it('prices nothing without the stated credit rate', () => {
    expect(
      parseStabilityPricing(PAGE.replace('1 credit', 'One credit')).size,
    ).toBe(0)
  })

  it('attaches a card only to an id the page names', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(PAGE))
    const uncached: typeof cachedDocs = (_kv, _url, load) => load()
    try {
      const lookup = await stabilityModelPricing(undefined, uncached)
      const named = lookup('Stable Image Ultra')
      expect(named.pricing).toMatchObject({ price: 0.08 })
      expect(named.factSources?.pricing).toMatchObject({
        sourceUrl: 'https://docs.stability.ai/pricing.md',
      })
      // Engine ids from /v1/engines/list are not page service names.
      expect(lookup('stable-diffusion-xl-1024-v1-0')).toEqual({})
      expect(lookup('SDXL 1.0')).toEqual({})
    } finally {
      fetchMock.mockRestore()
    }
  })
})
