import { describe, expect, it } from 'vitest'

import {
  compileElevenLabsSpeechCards,
  elevenLabsSpeechProduct,
  parseElevenLabsSpeechPrices,
} from './elevenlabs-pricing.ts'

const PAGE = `
<p>usage is billed in US dollars, not credits. Text to Speech $0.08 per 1,000 characters (multilingual models) or $0.04 (Flash/Turbo). Speech to Text $0.22 per hour.</p>
<p>Text to Speech $0.08 per 1,000 characters (multilingual models) or $0.04 (Flash/Turbo).</p>
`

const SOURCE = {
  url: 'https://elevenlabs.io/pricing/api',
  hash: 'abc',
  extractedAt: '2026-10-03T00:00:00.000Z',
}

describe('elevenlabs speech prices', () => {
  it('does not copy the FAQ summary onto speech products', () => {
    expect(parseElevenLabsSpeechPrices(PAGE)).toBeNull()
    expect(compileElevenLabsSpeechCards(PAGE, SOURCE)).toBeNull()
  })

  it('refuses a page that does not state the speech product price', () => {
    expect(parseElevenLabsSpeechPrices('<p>Contact sales</p>')).toBeNull()
    expect(
      compileElevenLabsSpeechCards('<p>Contact sales</p>', SOURCE),
    ).toBeNull()
  })

  it('refuses conflicting repeats of the speech price', () => {
    const conflict = `${PAGE} Text to Speech $0.10 per 1,000 characters (multilingual models) or $0.04 (Flash/Turbo).`
    expect(parseElevenLabsSpeechPrices(conflict)).toBeNull()
  })

  it('assigns Flash and Turbo ids to the half-price product', () => {
    expect(elevenLabsSpeechProduct('eleven_flash_v2_5')).toBe('flash')
    expect(elevenLabsSpeechProduct('eleven_turbo_v2_5')).toBe('flash')
    expect(elevenLabsSpeechProduct('eleven_multilingual_v2')).toBe(
      'multilingual',
    )
    expect(elevenLabsSpeechProduct('eleven_v3')).toBe('multilingual')
  })
})
