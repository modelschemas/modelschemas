import { describe, expect, it } from 'vitest'

import { verifyExamples } from '@modelschemas/rate-card'
import type { RateCard } from '@modelschemas/rate-card'

import {
  compileFalUnitCard,
  parseFalUnitRate,
  usdAmounts,
} from './fal-unit-rate.ts'

const SOURCE: RateCard['source'] = {
  url: 'https://fal.ai/models/fal-ai/x/llms.txt',
  hash: 'a'.repeat(64),
  extractedAt: '2026-09-21T06:00:00.000Z',
}

function compile(section: string, properties: Array<string> = []) {
  return compileFalUnitCard(section, new Set(properties), SOURCE)
}

describe('usdAmounts', () => {
  it('reads plain, bold, and suffix-$ spellings', () => {
    expect(usdAmounts('$0.04')).toEqual([0.04])
    expect(usdAmounts('$**0.04**')).toEqual([0.04])
    expect(usdAmounts('**0.17** $')).toEqual([0.17])
    expect(usdAmounts('**$0.08** per image')).toEqual([0.08])
  })

  it('ignores zeros and sections with no price', () => {
    expect(usdAmounts('- **Price**: $0 per compute seconds')).toEqual([])
    expect(usdAmounts('See [fal.ai pricing](https://fal.ai/pricing).')).toEqual(
      [],
    )
  })
})

describe('parseFalUnitRate', () => {
  it('reads the common FAL price line', () => {
    expect(parseFalUnitRate('- **Price**: $0.04 per megapixels')).toMatchObject(
      { amount: 0.04, count: 1, param: 'megapixels' },
    )
    expect(
      parseFalUnitRate('- **Price**: $0.05 per 1000 characters'),
    ).toMatchObject({ amount: 0.05, count: 1000, param: 'characters' })
    expect(parseFalUnitRate('- **Price**: $0 per compute seconds')).toBeNull()
  })

  it('reads prose rates, slashes, and bold money', () => {
    expect(
      parseFalUnitRate('Your request will cost **$0.08** per image.'),
    ).toMatchObject({ amount: 0.08, param: 'images' })
    expect(
      parseFalUnitRate('it will cost **$0.045/sec** of generated video.'),
    ).toMatchObject({ amount: 0.045, param: 'seconds' })
    expect(parseFalUnitRate('- **Price**: $**0.04** per images')).toMatchObject(
      { amount: 0.04, param: 'images' },
    )
    expect(
      parseFalUnitRate('- **Price**: **0.17** $ per second'),
    ).toMatchObject({ amount: 0.17, param: 'seconds' })
  })

  it('ignores the "for $1.00 you can run this N times" restatement', () => {
    expect(
      parseFalUnitRate(
        'Your request will cost **$0.039** per image. For **$1.00**, you can run this model **25 times.**',
      ),
    ).toMatchObject({ amount: 0.039, param: 'images' })
  })

  it('refuses anything with more than one rate, or an unknown unit', () => {
    expect(
      parseFalUnitRate(
        'Video costs **$0.025** per second at **480p**, and **$0.08** per second at **1080p**.',
      ),
    ).toBeNull()
    expect(
      parseFalUnitRate(
        'Your request will cost **$0.08** per image. If web search is used, an additional $0.015 will be charged.',
      ),
    ).toBeNull()
    expect(parseFalUnitRate('- **Price**: $0.02 per widgets')).toBeNull()
    expect(parseFalUnitRate('- **Price**: $0.02 per ')).toBeNull()
  })
})

describe('compileFalUnitCard', () => {
  it('synthesizes a one-unit example that verifies against the quote', () => {
    const card = compile('- **Price**: $0.04 per megapixels')
    expect(card).not.toBeNull()
    if (!card) return
    expect(card.examples).toEqual([
      {
        params: { megapixels: 1 },
        usd: 0.04,
        quote: '- **Price**: $0.04 per megapixels',
      },
    ])
    expect(card.inputs.megapixels).toMatchObject({ bound: 'usage' })
    expect(verifyExamples(card).every((result) => result.ok)).toBe(true)
  })

  it('prices the quoted denominator, not one of it', () => {
    const card = compile('- **Price**: $0.05 per 1000 characters')
    expect(card?.examples[0]).toMatchObject({
      params: { characters: 1000 },
      usd: 0.05,
    })
    expect(card && verifyExamples(card).every((r) => r.ok)).toBe(true)
  })

  it('binds to the request only when the endpoint really has that field', () => {
    expect(
      compile('- **Price**: $0.04 per images', ['images'])?.inputs.images,
    ).toMatchObject({ bound: 'request' })
    expect(
      compile('- **Price**: $0.04 per images', ['prompt'])?.inputs.images,
    ).toMatchObject({ bound: 'usage' })
  })

  it('returns null for stubs and multi-rate tables', () => {
    expect(compile('- **Price**: $0 per compute seconds')).toBeNull()
    expect(
      compile(
        'Video costs **$0.025** per second at **480p**, and **$0.08** per second at **1080p**.',
      ),
    ).toBeNull()
  })
})
