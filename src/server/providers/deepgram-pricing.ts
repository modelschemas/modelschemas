/**
 * Deepgram Pay As You Go prices from https://deepgram.com/pricing (issue #121).
 * JSON-LD offers name the product; the page text must show the same number
 * with `/min` or `/1k`. Growth is a prepaid discount, not the list price.
 * Add-ons and Voice Agent tiers are not model rates. Nova-2, Enhanced, and
 * Base are absent from the current offers, so those rows stay null.
 * Whisper Large is priced for pre-recorded only while the model also streams,
 * so that id stays null rather than quoting one mode for both.
 */
import { compileUnitCard } from '@modelschemas/rate-card'
import type { RateCard } from '@modelschemas/rate-card'

import { tagDocsFacts } from './fact-sources.ts'
import { assertParsed, cachedDocs } from './model-facts.ts'
import { fetchText, sha256Text } from './types.ts'
import type { ModelInfo } from './types.ts'

export const DEEPGRAM_PRICING_URL = 'https://deepgram.com/pricing'

const PAYG = 'Pay As You Go'

const REQUIRED = [
  'Streaming - Flux English',
  'Streaming - Flux Multilingual',
  'Streaming - Nova-3 Monolingual',
  'Streaming - Nova-3 Multilingual',
  'Pre-Recorded - Nova-3 Monolingual',
  'Pre-Recorded - Nova-3 Multilingual',
  'Flux TTS',
  'Aura-2',
  'Aura-1',
] as const

const OFFER =
  /Deepgram Voice AI Platform Pricing - (.+?) - (Pay As You Go|Growth)(?:\\)?"\s*,\s*(?:\\)?"price(?:\\)?"\s*:\s*(?:\\)?"(\d+(?:\.\d+)?)/g

function unitFor(product: string): '/min' | '/1k' | null {
  if (
    product.startsWith('Streaming - ') ||
    product.startsWith('Pre-Recorded - ')
  ) {
    return '/min'
  }
  if (product === 'Flux TTS' || product === 'Aura-2' || product === 'Aura-1') {
    return '/1k'
  }
  return null
}

function pageShows(
  html: string,
  amount: number,
  unit: '/min' | '/1k',
): boolean {
  const text = html.replace(/\\u002f/gi, '/')
  const forms = new Set<string>([
    String(amount),
    amount.toFixed(4).replace(/0+$/, '').replace(/\.$/, ''),
    amount.toFixed(4),
    amount.toFixed(3),
    amount.toFixed(2),
  ])
  for (const form of forms) {
    if (form.length > 0 && text.includes(`$${form}${unit}`)) return true
  }
  return false
}

/** Pay As You Go product → published amount (`/min` or `/1k`). Empty on a bad page. */
export function parseDeepgramPricing(html: string): Map<string, number> {
  const out = new Map<string, number>()
  for (const match of html.matchAll(OFFER)) {
    const product = match[1]
    const plan = match[2]
    const amount = match[3] ? Number(match[3]) : Number.NaN
    if (!product || plan !== PAYG || !Number.isFinite(amount) || amount <= 0) {
      continue
    }
    const unit = unitFor(product)
    if (!unit || !pageShows(html, amount, unit)) continue
    const prior = out.get(product)
    if (prior !== undefined && prior !== amount) return new Map()
    out.set(product, amount)
  }
  if (REQUIRED.some((product) => !out.has(product))) return new Map()
  return out
}

function perMinute(rates: Map<string, number>, product: string): number | null {
  const amount = rates.get(product)
  return amount === undefined ? null : amount / 60
}

function perCharacter(
  rates: Map<string, number>,
  product: string,
): number | null {
  const amount = rates.get(product)
  return amount === undefined ? null : amount / 1000
}

/**
 * One shared card for a model family. Nova-3 general bills monolingual and
 * multilingual, and streaming and pre-recorded, at different published rates.
 * The caller supplies those usage levers; they are not request fields.
 */
export function deepgramCard(
  rawId: string,
  rates: Map<string, number>,
  source: RateCard['source'],
): RateCard | null {
  const listen = (
    streaming: number | null,
    preRecorded: number | null,
  ): RateCard | null => {
    if (streaming === null || preRecorded === null) return null
    return compileUnitCard(
      {
        quantity: { param: 'audio_seconds', bound: 'usage' },
        keys: [
          {
            param: 'listen_mode',
            values: ['streaming', 'pre_recorded'],
            bound: 'usage',
          },
        ],
        rates: { streaming, pre_recorded: preRecorded },
      },
      source,
    )
  }

  if (rawId === 'flux-general-en') {
    const streaming = perMinute(rates, 'Streaming - Flux English')
    if (streaming === null) return null
    return compileUnitCard(
      {
        quantity: { param: 'audio_seconds', bound: 'usage' },
        rates: streaming,
      },
      source,
    )
  }
  if (rawId === 'flux-general-multi') {
    const streaming = perMinute(rates, 'Streaming - Flux Multilingual')
    if (streaming === null) return null
    return compileUnitCard(
      {
        quantity: { param: 'audio_seconds', bound: 'usage' },
        rates: streaming,
      },
      source,
    )
  }
  if (rawId.startsWith('flux-')) {
    const characters = perCharacter(rates, 'Flux TTS')
    if (characters === null) return null
    return compileUnitCard(
      {
        quantity: { param: 'characters', bound: 'usage' },
        rates: characters,
      },
      source,
    )
  }
  if (rawId.startsWith('aura-2-')) {
    const characters = perCharacter(rates, 'Aura-2')
    if (characters === null) return null
    return compileUnitCard(
      {
        quantity: { param: 'characters', bound: 'usage' },
        rates: characters,
      },
      source,
    )
  }
  if (rawId.startsWith('aura-')) {
    const characters = perCharacter(rates, 'Aura-1')
    if (characters === null) return null
    return compileUnitCard(
      {
        quantity: { param: 'characters', bound: 'usage' },
        rates: characters,
      },
      source,
    )
  }
  if (rawId === 'nova-3' || rawId === 'nova-3-general') {
    const streamingMono = perMinute(rates, 'Streaming - Nova-3 Monolingual')
    const streamingMulti = perMinute(rates, 'Streaming - Nova-3 Multilingual')
    const batchMono = perMinute(rates, 'Pre-Recorded - Nova-3 Monolingual')
    const batchMulti = perMinute(rates, 'Pre-Recorded - Nova-3 Multilingual')
    if (
      streamingMono === null ||
      streamingMulti === null ||
      batchMono === null ||
      batchMulti === null
    ) {
      return null
    }
    return compileUnitCard(
      {
        quantity: { param: 'audio_seconds', bound: 'usage' },
        keys: [
          {
            param: 'listen_mode',
            values: ['streaming', 'pre_recorded'],
            bound: 'usage',
          },
          {
            param: 'language_scope',
            values: ['monolingual', 'multilingual'],
            bound: 'usage',
          },
        ],
        rates: {
          streaming: {
            monolingual: streamingMono,
            multilingual: streamingMulti,
          },
          pre_recorded: {
            monolingual: batchMono,
            multilingual: batchMulti,
          },
        },
      },
      source,
    )
  }
  if (rawId.startsWith('nova-3-')) {
    return listen(
      perMinute(rates, 'Streaming - Nova-3 Monolingual'),
      perMinute(rates, 'Pre-Recorded - Nova-3 Monolingual'),
    )
  }
  return null
}

type PricedFacts = Pick<ModelInfo, 'pricing' | 'factSources'>

export async function deepgramModelPricing(
  kv?: KVNamespace,
): Promise<(rawId: string) => PricedFacts> {
  const doc = await cachedDocs(kv, DEEPGRAM_PRICING_URL, async () => {
    const html = await fetchText(DEEPGRAM_PRICING_URL)
    const parsed = parseDeepgramPricing(html)
    assertParsed(parsed, 'deepgram pricing page')
    return {
      rates: Object.fromEntries(parsed),
      hash: await sha256Text(html),
      extractedAt: new Date().toISOString(),
    }
  })
  const rates = new Map(Object.entries(doc.rates))
  const source = {
    url: DEEPGRAM_PRICING_URL,
    hash: doc.hash,
    extractedAt: doc.extractedAt,
  }
  return (rawId) => {
    const pricing = deepgramCard(rawId, rates, source)
    if (!pricing) return {}
    return {
      pricing,
      factSources: tagDocsFacts({ pricing }, DEEPGRAM_PRICING_URL, doc.hash),
    }
  }
}
