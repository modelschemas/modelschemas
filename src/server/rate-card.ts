/**
 * Rate cards on the catalog (issue #60): store only values that parse as
 * RateCard, compile OpenRouter listings at write, and project a compact
 * token formula on list rows.
 */
import {
  compileOpenRouterPricing,
  price,
  rateCardSchema,
  RateCardError,
  verifyExamples,
} from '@modelschemas/rate-card'
import type { RateCard } from '@modelschemas/rate-card'

import { contentHash } from '#/server/kv.ts'
import { emptySources } from '#/server/providers/fact-sources.ts'
import type { ModelFactSources } from '#/server/providers/types.ts'

/**
 * Usage quantities the card may name even when they are not properties of
 * the bound request schema (`input_tokens` is the type specimen).
 */
const CARD_LEVEL_LEVERS = new Set([
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
  'cache_write_1h_tokens',
  'reasoning_tokens',
  'image_tokens',
  'image_output_tokens',
  'audio_tokens',
  'audio_output_tokens',
  'audio_cache_tokens',
  'web_searches',
  'requests',
])

export type CompactPricing = {
  inputPerMillion: number
  outputPerMillion: number
}

export function parseStoredRateCard(value: unknown): RateCard | null {
  const parsed = rateCardSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

function requestParamAllowed(
  param: string,
  requestProperties: ReadonlySet<string> | undefined,
): boolean {
  if (requestProperties === undefined) return true
  if (CARD_LEVEL_LEVERS.has(param)) return true
  if (requestProperties.has(param)) return true
  const root = param.split('.')[0]
  return root !== undefined && requestProperties.has(root)
}

function cardRequestParamsOk(
  card: RateCard,
  requestProperties: ReadonlySet<string> | undefined,
): boolean {
  for (const input of Object.values(card.inputs)) {
    if (input.bound === 'usage') continue
    if (!requestParamAllowed(input.param, requestProperties)) return false
  }
  return true
}

function examplesOk(card: RateCard): boolean {
  return !verifyExamples(card).some((result) => !result.ok)
}

export interface StoreRateCardOptions {
  /** Previously stored `models.pricing`, used to keep `source.extractedAt`. */
  existing?: unknown
  /**
   * Top-level properties of the bound input schema. `undefined` skips the
   * invented-field check (no bound schema). An empty set still refuses
   * unknown request-bound params.
   */
  requestProperties?: ReadonlySet<string>
  sourceUrl: string
  /** Poll time, epoch seconds. */
  now: number
}

/**
 * Value to write to `models.pricing`. Null means unknown — never a vendor
 * blob, never Together all-zero placeholders.
 */
export async function toStoredRateCard(
  pricing: unknown,
  options: StoreRateCardOptions,
): Promise<RateCard | null> {
  if (pricing == null) return null

  const parsed = parseStoredRateCard(pricing)
  if (parsed) {
    if (!cardRequestParamsOk(parsed, options.requestProperties)) return null
    if (!examplesOk(parsed)) return null
    return parsed
  }

  const existing = parseStoredRateCard(options.existing)
  const listingHash = await contentHash(pricing)
  if (existing && existing.source.hash === listingHash) {
    if (!cardRequestParamsOk(existing, options.requestProperties)) return null
    return existing
  }

  const compiled = compileOpenRouterPricing(pricing, {
    url: options.sourceUrl,
    hash: listingHash,
    extractedAt: new Date(options.now * 1000).toISOString(),
  })
  if (!compiled) return null
  if (!cardRequestParamsOk(compiled, options.requestProperties)) return null
  return compiled
}

/** Drop `factSources.pricing` when the stored card is null. */
export function reconcilePricingSource(
  sources: ModelFactSources | null | undefined,
  card: RateCard | null,
): ModelFactSources | null {
  const next: ModelFactSources = { ...(sources ?? {}) }
  if (card === null) delete next.pricing
  else if (next.pricing === undefined) next.pricing = { derivation: 'listing' }
  return emptySources(next) ? null : next
}

function isSimpleTokenCard(card: RateCard): boolean {
  let hasInput = false
  let hasOutput = false
  for (const input of Object.values(card.inputs)) {
    if (input.bound !== 'usage' || input.kind !== 'number') return false
    if (input.param === 'input_tokens') hasInput = true
    else if (input.param === 'output_tokens') hasOutput = true
  }
  return hasInput && hasOutput
}

function tryPrice(
  card: RateCard,
  usage: Record<string, number>,
): number | null {
  try {
    return price(card, {}, usage)
  } catch (error) {
    if (error instanceof RateCardError) return null
    throw error
  }
}

const LINEAR_REL_TOL = 1e-6

function linear(unit: number, million: number): boolean {
  return (
    Math.abs(unit * 1_000_000 - million) <=
    Math.max(1e-9, Math.abs(million) * LINEAR_REL_TOL)
  )
}

/**
 * `{ inputPerMillion, outputPerMillion }` when the card is a linear
 * usage-bound token formula; null for media cards and tiered/request-fee
 * formulas (list rows omit the dump).
 */
export function projectTokenPricing(card: RateCard): CompactPricing | null {
  if (!isSimpleTokenCard(card)) return null
  const in1 = tryPrice(card, { input_tokens: 1, output_tokens: 0 })
  const inM = tryPrice(card, { input_tokens: 1_000_000, output_tokens: 0 })
  const out1 = tryPrice(card, { input_tokens: 0, output_tokens: 1 })
  const outM = tryPrice(card, { input_tokens: 0, output_tokens: 1_000_000 })
  if (in1 === null || inM === null || out1 === null || outM === null) {
    return null
  }
  if (!linear(in1, inM) || !linear(out1, outM)) return null
  return { inputPerMillion: inM, outputPerMillion: outM }
}

export function servePricing(
  value: unknown,
  mode: 'compact' | 'full',
): RateCard | CompactPricing | null {
  const card = parseStoredRateCard(value)
  if (!card) return null
  if (mode === 'full') return card
  return projectTokenPricing(card)
}
