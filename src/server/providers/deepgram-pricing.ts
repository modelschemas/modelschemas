/**
 * Deepgram Pay As You Go prices from https://deepgram.com/pricing (issues
 * #121, #528). The page's JSON-LD `OfferCatalog` names each product, its
 * plan (`category`), USD price, and unit (`priceSpecification.unitText`).
 * Growth is a prepaid discount, not the list price. Add-ons, Voice Agent
 * tiers, and Audio Intelligence are not model rates. Nova-2, Enhanced, and
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

const PAYG = 'Pay as you go'

const REQUIRED = [
  'Speech-to-text: Flux STT English (Streaming)',
  'Speech-to-text: Flux STT Multilingual (Streaming)',
  'Speech-to-text: Nova-3 Monolingual (Streaming)',
  'Speech-to-text: Nova-3 Multilingual (Streaming)',
  'Speech-to-text: Nova-3 Monolingual (Pre-recorded)',
  'Speech-to-text: Nova-3 Multilingual (Pre-recorded)',
  'Text-to-speech: Flux TTS',
  'Text-to-speech: Aura-2',
  'Text-to-speech: Aura-1',
] as const

const LD_JSON =
  /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g

/** The `unitText` a product's rate must carry. */
function unitFor(product: string): 'minute' | '1,000 characters' | null {
  if (/^Speech-to-text: .+ \((?:Streaming|Pre-recorded)\)$/.test(product)) {
    return 'minute'
  }
  if (product.startsWith('Text-to-speech: ')) return '1,000 characters'
  return null
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function collectOffers(
  node: unknown,
  out: Array<Record<string, unknown>>,
): void {
  if (Array.isArray(node)) {
    for (const item of node) collectOffers(item, out)
    return
  }
  const obj = record(node)
  if (!obj) return
  if (obj['@type'] === 'Offer') out.push(obj)
  for (const value of Object.values(obj)) collectOffers(value, out)
}

/** Pay As You Go product → USD per minute or per 1k characters. Empty on a bad page. */
export function parseDeepgramPricing(html: string): Map<string, number> {
  const offers: Array<Record<string, unknown>> = []
  for (const match of html.matchAll(LD_JSON)) {
    collectOffers(JSON.parse(match[1] ?? '') as unknown, offers)
  }
  const out = new Map<string, number>()
  const suffix = ` — ${PAYG}`
  for (const offer of offers) {
    const name = offer.name
    if (offer.category !== PAYG || typeof name !== 'string') continue
    if (!name.endsWith(suffix)) continue
    const product = name.slice(0, -suffix.length)
    const spec = record(offer.priceSpecification)
    const amount = spec?.price
    if (
      spec?.priceCurrency !== 'USD' ||
      typeof amount !== 'number' ||
      !Number.isFinite(amount) ||
      amount <= 0 ||
      amount !== offer.price
    ) {
      continue
    }
    const unit = unitFor(product)
    if (!unit || spec.unitText !== unit) continue
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
    const streaming = perMinute(
      rates,
      'Speech-to-text: Flux STT English (Streaming)',
    )
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
    const streaming = perMinute(
      rates,
      'Speech-to-text: Flux STT Multilingual (Streaming)',
    )
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
    const characters = perCharacter(rates, 'Text-to-speech: Flux TTS')
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
    const characters = perCharacter(rates, 'Text-to-speech: Aura-2')
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
    const characters = perCharacter(rates, 'Text-to-speech: Aura-1')
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
    const streamingMono = perMinute(
      rates,
      'Speech-to-text: Nova-3 Monolingual (Streaming)',
    )
    const streamingMulti = perMinute(
      rates,
      'Speech-to-text: Nova-3 Multilingual (Streaming)',
    )
    const batchMono = perMinute(
      rates,
      'Speech-to-text: Nova-3 Monolingual (Pre-recorded)',
    )
    const batchMulti = perMinute(
      rates,
      'Speech-to-text: Nova-3 Multilingual (Pre-recorded)',
    )
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
      perMinute(rates, 'Speech-to-text: Nova-3 Monolingual (Streaming)'),
      perMinute(rates, 'Speech-to-text: Nova-3 Monolingual (Pre-recorded)'),
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
