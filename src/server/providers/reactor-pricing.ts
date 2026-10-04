/**
 * Reactor prices (issue #120). `GET /pricing` publishes credits per second
 * and, when a dollar rate exists, `amount_per_sec_usd`. Credits alone are
 * not a RateCard. This does not divide credits by `credits_per_dollar`.
 */
import { compileUnitCard } from '@modelschemas/rate-card'
import type { RateCard } from '@modelschemas/rate-card'

import { tagDocsFacts } from './fact-sources.ts'
import type { ModelInfo } from './types.ts'

export interface ReactorRate {
  amount_per_sec?: number
  amount_per_sec_usd?: string | number
  currency_code?: string
  unit?: string
  denomination?: string
}

type PricedFacts = Pick<ModelInfo, 'pricing' | 'factSources'>

function usdPerSecond(rate: ReactorRate): number | null {
  if (rate.currency_code !== 'USD') return null
  const raw = rate.amount_per_sec_usd
  if (typeof raw !== 'string' && typeof raw !== 'number') return null
  const dollars = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(dollars) || dollars <= 0) return null
  return dollars
}

/** USD per second of video, or null when the row has no published USD rate. */
export function compileReactorRate(
  rate: ReactorRate | null | undefined,
  source: RateCard['source'],
): RateCard | null {
  if (!rate) return null
  const dollars = usdPerSecond(rate)
  if (dollars === null) return null
  return compileUnitCard(
    {
      quantity: { param: 'video_seconds', bound: 'usage' },
      rates: dollars,
    },
    source,
  )
}

export function reactorPricingFacts(
  rate: ReactorRate | null | undefined,
  source: RateCard['source'],
): PricedFacts {
  const pricing = compileReactorRate(rate, source)
  if (!pricing) return {}
  return {
    pricing,
    factSources: tagDocsFacts({ pricing }, source.url, source.hash),
  }
}
