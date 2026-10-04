/**
 * ElevenLabs speech product prices (issue #120). The FAQ sentence
 * ("$0.08 multilingual or $0.04 Flash/Turbo") is a summary, not the
 * product cards. Those cards name different numbers (v4, v3
 * Conversational). Copying the FAQ onto every speech id stores the
 * wrong rate, so this parser stays null until it reads a per-product
 * figure. Enum-only catalog rows stay unpriced.
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
  // The FAQ regex still matches the live page. It is not a product price.
  void page
  void SPEECH_PRICE
  return null
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
    return { cards, hash: source.hash, extractedAt }
  })
  return (rawId) => {
    if (!doc.cards) return {}
    const pricing = doc.cards[elevenLabsSpeechProduct(rawId)]
    return {
      pricing,
      factSources: tagDocsFacts({ pricing }, ELEVENLABS_PRICING_URL, doc.hash),
    }
  }
}
