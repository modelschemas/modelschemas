import { describe, expect, it } from 'vitest'

import { price } from '@modelschemas/rate-card'
import type { RateCard } from '@modelschemas/rate-card'

import { deepgramCard, parseDeepgramPricing } from './deepgram-pricing.ts'

const SOURCE = {
  url: 'https://deepgram.com/pricing',
  hash: 'abc',
  extractedAt: '2026-10-03T00:00:00.000Z',
}

type Row = [product: string, amount: number, unit?: string]

function offer(product: string, plan: string, amount: number, unit: string) {
  return {
    '@type': 'Offer',
    name: `${product} — ${plan}`,
    category: plan,
    price: amount,
    priceCurrency: 'USD',
    priceSpecification: {
      '@type': 'UnitPriceSpecification',
      price: amount,
      priceCurrency: 'USD',
      unitText: unit,
    },
  }
}

function page(rows: Array<Row>, extra: Array<object> = []): string {
  const items = rows.map(([product, amount, unit]) =>
    offer(
      product,
      'Pay as you go',
      amount,
      unit ??
        (product.startsWith('Text-to-speech: ')
          ? '1,000 characters'
          : 'minute'),
    ),
  )
  const ld = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'OfferCatalog',
        name: 'Rates by product',
        itemListElement: [...items, ...extra],
      },
    ],
  }
  return `<html><script type="application/ld+json">${JSON.stringify(ld)}</script></html>`
}

const ROWS: Array<Row> = [
  ['Speech-to-text: Flux STT English (Streaming)', 0.0077],
  ['Speech-to-text: Flux STT Multilingual (Streaming)', 0.0078],
  ['Speech-to-text: Nova-3 Monolingual (Streaming)', 0.0048],
  ['Speech-to-text: Nova-3 Multilingual (Streaming)', 0.0058],
  ['Speech-to-text: Nova-3 Monolingual (Pre-recorded)', 0.0043],
  ['Speech-to-text: Nova-3 Multilingual (Pre-recorded)', 0.0052],
  ['Speech-to-text: Whisper Large (Pre-recorded)', 0.0048],
  ['Text-to-speech: Flux TTS', 0.045],
  ['Text-to-speech: Aura-2', 0.03],
  ['Text-to-speech: Aura-1', 0.015],
]

const PAGE = page(ROWS, [
  offer(
    'Speech-to-text: Nova-3 Monolingual (Streaming)',
    'Growth',
    9.99,
    'minute',
  ),
])

function usd(
  card: RateCard | null,
  usage: Record<string, number | string>,
): number {
  if (!card) throw new Error('missing card')
  return price(card, {}, usage)
}

describe('deepgram pricing page', () => {
  it('reads Pay As You Go offers from the JSON-LD catalog, not Growth', () => {
    const rates = parseDeepgramPricing(PAGE)
    expect(rates.get('Speech-to-text: Flux STT English (Streaming)')).toBe(
      0.0077,
    )
    expect(rates.get('Text-to-speech: Aura-2')).toBe(0.03)
    expect(rates.get('Text-to-speech: Aura-1')).toBe(0.015)
    expect(rates.get('Speech-to-text: Nova-3 Monolingual (Streaming)')).toBe(
      0.0048,
    )
  })

  it('refuses the page when a required rate carries the wrong unit or is missing', () => {
    const wrongUnit = ROWS.map((row): Row =>
      row[0] === 'Text-to-speech: Aura-2' ? [row[0], row[1], 'minute'] : row,
    )
    expect(parseDeepgramPricing(page(wrongUnit))).toEqual(new Map())
    expect(parseDeepgramPricing(page(ROWS.slice(1)))).toEqual(new Map())
  })

  it('refuses conflicting Pay as you go rates and ignores a Growth-category offer', () => {
    const aura = offer(
      'Text-to-speech: Aura-2',
      'Pay as you go',
      0.04,
      '1,000 characters',
    )
    expect(parseDeepgramPricing(page(ROWS, [aura]))).toEqual(new Map())
    const growth = { ...aura, category: 'Growth' }
    expect(
      parseDeepgramPricing(page(ROWS, [growth])).get('Text-to-speech: Aura-2'),
    ).toBe(0.03)
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
    ).toBeCloseTo(0.0077, 9)
  })
})
