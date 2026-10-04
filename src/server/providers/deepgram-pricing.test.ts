import { describe, expect, it } from 'vitest'

import { price } from '@modelschemas/rate-card'
import type { RateCard } from '@modelschemas/rate-card'

import { deepgramCard, parseDeepgramPricing } from './deepgram-pricing.ts'

const SOURCE = {
  url: 'https://deepgram.com/pricing',
  hash: 'abc',
  extractedAt: '2026-10-03T00:00:00.000Z',
}

function offers(rows: Array<[string, string]>): string {
  const ld = rows
    .map(
      ([product, amount]) =>
        `{"@type":"Offer","name":"Deepgram Voice AI Platform Pricing - ${product} - Pay As You Go","price":"${amount}","priceCurrency":"USD"}`,
    )
    .join(',')
  const units = rows
    .map(([product, amount]) =>
      product === 'Flux TTS' || product.startsWith('Aura')
        ? `$${amount}/1k characters`
        : `$${amount}/min`,
    )
    .join(' ')
  return `${ld} ${units}`
}

const PAGE =
  offers([
    ['Streaming - Flux English', '0.0065'],
    ['Streaming - Flux Multilingual', '0.0078'],
    ['Streaming - Nova-3 Monolingual', '0.0048'],
    ['Streaming - Nova-3 Multilingual', '0.0058'],
    ['Pre-Recorded - Nova-3 Monolingual', '0.0043'],
    ['Pre-Recorded - Nova-3 Multilingual', '0.0052'],
    ['Pre-Recorded - Whisper Large', '0.0048'],
    ['Flux TTS', '0.0450'],
    ['Aura-2', '0.030'],
    ['Aura-1', '0.0150'],
  ]) +
  '{"@type":"Offer","name":"Deepgram Voice AI Platform Pricing - Streaming - Nova-3 Monolingual - Growth","price":"9.99"}'

function usd(
  card: RateCard | null,
  usage: Record<string, number | string>,
): number {
  if (!card) throw new Error('missing card')
  return price(card, {}, usage)
}

describe('deepgram pricing page', () => {
  it('reads Pay As You Go family rates and skips a unit the page does not show', () => {
    const rates = parseDeepgramPricing(PAGE)
    expect(rates.get('Streaming - Flux English')).toBe(0.0065)
    expect(rates.get('Aura-2')).toBe(0.03)
    expect(rates.get('Aura-1')).toBe(0.015)
    expect(rates.get('Streaming - Nova-3 Monolingual')).toBe(0.0048)
    expect(parseDeepgramPricing(PAGE.replace('$0.0065/min', ''))).toEqual(
      new Map(),
    )
  })

  it('shares one Aura-2 character rate and prices Nova-3 by mode', () => {
    const rates = parseDeepgramPricing(PAGE)
    const aura = deepgramCard('aura-2-thalia-en', rates, SOURCE)
    const aura1 = deepgramCard('aura-asteria-en', rates, SOURCE)
    const fluxVoice = deepgramCard('flux-alexis-en', rates, SOURCE)
    const nova = deepgramCard('nova-3-general', rates, SOURCE)
    const medical = deepgramCard('nova-3-medical', rates, SOURCE)
    expect(usd(aura, { characters: 1000 })).toBeCloseTo(0.03, 9)
    expect(usd(aura1, { characters: 1000 })).toBeCloseTo(0.015, 9)
    expect(usd(fluxVoice, { characters: 1000 })).toBeCloseTo(0.045, 9)
    expect(
      usd(nova, {
        audio_seconds: 60,
        listen_mode: 'streaming',
        language_scope: 'monolingual',
      }),
    ).toBeCloseTo(0.0048, 9)
    expect(
      usd(nova, {
        audio_seconds: 60,
        listen_mode: 'pre_recorded',
        language_scope: 'multilingual',
      }),
    ).toBeCloseTo(0.0052, 9)
    expect(
      usd(medical, { audio_seconds: 60, listen_mode: 'pre_recorded' }),
    ).toBeCloseTo(0.0043, 9)
    expect(deepgramCard('nova-2-general', rates, SOURCE)).toBeNull()
    expect(deepgramCard('whisper-large', rates, SOURCE)).toBeNull()
    expect(deepgramCard('enhanced-general', rates, SOURCE)).toBeNull()
    expect(
      usd(deepgramCard('flux-general-en', rates, SOURCE), {
        audio_seconds: 60,
      }),
    ).toBeCloseTo(0.0065, 9)
  })
})
