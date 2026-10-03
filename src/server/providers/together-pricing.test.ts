import { describe, expect, it } from 'vitest'

import { price } from '@modelschemas/rate-card'

import {
  parseTogetherMediaPrices,
  togetherMediaCard,
} from './together-pricing.ts'

const CATALOG = `
## Image models

| Organization | Model name | Model string for API | Unit | Price | Output per $1 |
| :- | :- | :- | :- | :- | :- |
| Black Forest Labs | Flux1.1 [pro] | black-forest-labs/FLUX.1.1-pro | \`megapixel\` | \\$0.04 | 25 megapixels |
| Black Forest Labs | FLUX.2 [pro] | black-forest-labs/FLUX.2-pro | \`image\` | \\$0.03+ ([varies](https://example.com)) | 33 images |
| Black Forest Labs | FLUX.2 [max] | black-forest-labs/FLUX.2-max | \`megapixel\` | \\$0.07 at 50 steps | 14 megapixels |

## Video models

| Organization | Model name | Model string for API | Price per video | Resolution / duration |
| :- | :- | :- | :- | :- |
| ByteDance | Seedance 1.0 Pro | ByteDance/Seedance-1.0-pro | \\$0.57 | 1080p / 5s |
| ByteDance | Seedance 2.0 | ByteDance/Seedance-2.0 | \\$0.16 | - |
| Black Forest Labs | FLUX 3 | black-forest-labs/FLUX-3 | \\$0.17 | - |

## Audio models

| Organization | Modality | Model name | Model string for API | Pricing |
| :- | :- | :- | :- | :- |
| Cartesia | Text-to-Speech | Cartesia Sonic 3 | cartesia/sonic-3 | \\$65.00 per 1M chars |
| OpenAI | Speech-to-Text | Whisper Large v3 | openai/whisper-large-v3 | \\$0.0015 per audio min |
`

const source = {
  url: 'https://docs.together.ai/docs/serverless/models.md',
  hash: 'abc',
  extractedAt: '2026-10-03T00:00:00.000Z',
}

function cardFor(id: string) {
  const spec = parseTogetherMediaPrices(CATALOG).get(id.toLowerCase())
  if (!spec) return null
  return togetherMediaCard(spec, source)
}

describe('together media catalog', () => {
  it('compiles a megapixel image rate and skips a varying per-image estimate', () => {
    const card = cardFor('black-forest-labs/FLUX.1.1-pro')
    if (!card) throw new Error('did not compile')
    expect(price(card, {}, { megapixels: 2 })).toBeCloseTo(0.08, 9)
    const max = cardFor('black-forest-labs/FLUX.2-max')
    if (!max) throw new Error('did not compile')
    expect(price(max, {}, { megapixels: 1 })).toBeCloseTo(0.07, 9)
    expect(cardFor('black-forest-labs/FLUX.2-pro')).toBeNull()
  })

  it('compiles video per second when a length is published, else per video', () => {
    const clip = cardFor('ByteDance/Seedance-1.0-pro')
    if (!clip) throw new Error('did not compile')
    expect(price(clip, {}, { seconds: 5 })).toBeCloseTo(0.57, 9)
    const flat = cardFor('bytedance/seedance-2.0')
    if (!flat) throw new Error('did not compile')
    expect(price(flat, {}, {})).toBeCloseTo(0.16, 9)
    const flux = cardFor('black-forest-labs/FLUX-3')
    if (!flux) throw new Error('did not compile')
    expect(price(flux, {}, {})).toBeCloseTo(0.17, 9)
  })

  it('compiles character and audio-minute rates', () => {
    const speech = cardFor('cartesia/sonic-3')
    if (!speech) throw new Error('did not compile')
    expect(price(speech, {}, { characters: 1e6 })).toBeCloseTo(65, 9)
    const whisper = cardFor('openai/whisper-large-v3')
    if (!whisper) throw new Error('did not compile')
    expect(price(whisper, {}, { audio_seconds: 60 })).toBeCloseTo(0.0015, 9)
    expect(cardFor('cartesia/sonic-3.5')).toBeNull()
  })
})
