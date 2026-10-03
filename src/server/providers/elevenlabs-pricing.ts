/**
 * ElevenLabs speech product prices (issue #120). The API pricing page
 * states one Text to Speech rate for multilingual models and one for
 * Flash/Turbo. That card is copied onto every speech model it names.
 * Enum-only catalog rows are not speech products and stay unpriced.
 * Promo strikethroughs are not a second rate.
 */
import { compileUnitCard } from '@modelschemas/rate-card'
import type { RateCard } from '@modelschemas/rate-card'

import { tagDocsFacts } from './fact-sources.ts'
import { cachedDocs } from './model-facts.ts'
import { fetchText, sha256Text } from './types.ts'
import type { ModelInfo } from './types.ts'

export const ELEVENLABS_PRICING_URL = 'https://elevenlabs.io/pricing/api'

const SPEECH_PRICE =
  /Text to Speech \$(\d+(?:\.\d+)?) per 1,000 characters \(multilingual models\) or \$(\d+(?:\.\d+)?) \(Flash\/Turbo\)/g

export interface ElevenLabsSpeechPrices {
  /** USD per character for multilingual (non-Flash/Turbo) speech models. */
  multilingual: number
  /** USD per character for Flash and Turbo speech models. */
  flash: number
}

/**
 * The published speech product rates, in USD per character.
 * `null` when the page does not state both numbers, or states them twice
 * differently.
 */
export function parseElevenLabsSpeechPrices(
  page: string,
): ElevenLabsSpeechPrices | null {
  const found = [...page.matchAll(SPEECH_PRICE)]
  const first = found[0]
  if (!first?.[1] || !first[2]) return null
  const multilingual = Number(first[1]) / 1000
  const flash = Number(first[2]) / 1000
  if (!(multilingual > 0) || !(flash > 0)) return null
  for (const match of found.slice(1)) {
    if (Number(match[1]) / 1000 !== multilingual) return null
    if (Number(match[2]) / 1000 !== flash) return null
  }
  return { multilingual, flash }
}

export interface ElevenLabsSpeechCards {
  multilingual: RateCard
  flash: RateCard
}

/** One card per published speech product. `null` when the page states none. */
export function compileElevenLabsSpeechCards(
  page: string,
  source: RateCard['source'],
): ElevenLabsSpeechCards | null {
  const prices = parseElevenLabsSpeechPrices(page)
  if (!prices) return null
  const characters = { param: 'characters', bound: 'usage' as const }
  const multilingual = compileUnitCard(
    { quantity: characters, rates: prices.multilingual },
    source,
  )
  const flash = compileUnitCard(
    { quantity: characters, rates: prices.flash },
    source,
  )
  if (!multilingual || !flash) return null
  return { multilingual, flash }
}

type PricedFacts = Pick<ModelInfo, 'pricing' | 'factSources'>

/**
 * Flash and Turbo are the half-price speech product. Every other
 * text-to-speech id on the speech list takes the multilingual card.
 * `canDoTextToSpeech: false` (speech-to-speech only) and enum-only rows
 * are not passed here.
 */
export function elevenLabsSpeechProduct(
  rawId: string,
): 'flash' | 'multilingual' {
  return /flash|turbo/i.test(rawId) ? 'flash' : 'multilingual'
}

export async function elevenLabsSpeechPricing(
  kv?: KVNamespace,
): Promise<(rawId: string) => PricedFacts> {
  const doc = await cachedDocs(kv, ELEVENLABS_PRICING_URL, async () => {
    const page = await fetchText(ELEVENLABS_PRICING_URL)
    const extractedAt = new Date().toISOString()
    const source = {
      url: ELEVENLABS_PRICING_URL,
      hash: await sha256Text(page),
      extractedAt,
    }
    const cards = compileElevenLabsSpeechCards(page, source)
    if (!cards) {
      throw new Error('elevenlabs pricing page: parsed 0 speech prices')
    }
    return { ...cards, hash: source.hash, extractedAt }
  })
  return (rawId) => {
    const pricing = doc[elevenLabsSpeechProduct(rawId)]
    return {
      pricing,
      factSources: tagDocsFacts({ pricing }, ELEVENLABS_PRICING_URL, doc.hash),
    }
  }
}
