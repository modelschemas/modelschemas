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
 * Request-bound param names allowed even when they are not properties of
 * the bound input schema (`input_tokens` is the type specimen). Usage-bound
 * params skip this check.
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

/**
 * What a list row says about a stored card. `null` on the row means no
 * card; this means there is one. Token cards carry their per-million rates
 * when those are linear (`tiered` marks a long-prompt re-quote above some
 * threshold — the rates shown are the base); everything else names the
 * unit it bills by and points at the full card.
 */
export type CompactPricing = {
  per: 'token' | 'second' | 'character' | 'image' | 'request' | 'unit'
  inputPerMillion?: number
  outputPerMillion?: number
  tiered?: true
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

export type RateCardRefuse = 'invented_param' | 'examples' | 'uncompilable'

export type StoredPricing = {
  card: RateCard | null
  refused?: RateCardRefuse
}

/**
 * Value to write to `models.pricing`. Null means unknown — never a vendor
 * blob, never an all-zero OpenRouter-shaped listing.
 */
/**
 * A stored card stands in for a fresh one while its source text is
 * unchanged — except past `expiresAt`, the instant the source said the
 * price changes, where the re-read wins.
 */
function reusable(
  prior: RateCard | null,
  hash: string,
  now: number,
): prior is RateCard {
  if (!prior || prior.source.hash !== hash) return false
  const expiresAt = prior.source.expiresAt
  return expiresAt === undefined || Date.parse(expiresAt) > now * 1000
}

export async function storeListedPricing(
  pricing: unknown,
  options: StoreRateCardOptions,
): Promise<StoredPricing> {
  if (pricing == null) return { card: null }

  const parsed = parseStoredRateCard(pricing)
  if (parsed) {
    if (!cardRequestParamsOk(parsed, options.requestProperties)) {
      return { card: null, refused: 'invented_param' }
    }
    if (!examplesOk(parsed)) return { card: null, refused: 'examples' }
    // Same source text ⇒ same card. Keep the stored one so a fresh
    // `extractedAt` alone is not a price change on every poll. A parser
    // fix therefore lands with the next upstream edit, not before.
    const prior = parseStoredRateCard(options.existing)
    return {
      card: reusable(prior, parsed.source.hash, options.now) ? prior : parsed,
    }
  }

  const existing = parseStoredRateCard(options.existing)
  const listingHash = await contentHash(pricing)
  if (reusable(existing, listingHash, options.now)) {
    if (!cardRequestParamsOk(existing, options.requestProperties)) {
      return { card: null, refused: 'invented_param' }
    }
    return { card: existing }
  }

  const compiled = compileOpenRouterPricing(pricing, {
    url: options.sourceUrl,
    hash: listingHash,
    extractedAt: new Date(options.now * 1000).toISOString(),
  })
  if (!compiled) return { card: null, refused: 'uncompilable' }
  if (!cardRequestParamsOk(compiled, options.requestProperties)) {
    return { card: null, refused: 'invented_param' }
  }
  return { card: compiled }
}

export async function toStoredRateCard(
  pricing: unknown,
  options: StoreRateCardOptions,
): Promise<RateCard | null> {
  return (await storeListedPricing(pricing, options)).card
}

/**
 * Drop `factSources.pricing` when the stored card is null. If a card is
 * stored and pricing provenance is missing, stamp `{ derivation: listing }`.
 */
export function reconcilePricingSource(
  sources: ModelFactSources | null | undefined,
  card: RateCard | null,
): ModelFactSources | null {
  const next: ModelFactSources = { ...(sources ?? {}) }
  if (card === null) delete next.pricing
  else if (next.pricing === undefined) next.pricing = { derivation: 'listing' }
  return emptySources(next) ? null : next
}

function isTokenCard(card: RateCard): boolean {
  let hasInput = false
  for (const input of Object.values(card.inputs)) {
    if (input.bound !== 'usage' || input.kind !== 'number') return false
    if (input.param === 'input_tokens') hasInput = true
  }
  return hasInput
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

function linear(unitRate: number, count: number, total: number): boolean {
  return (
    Math.abs(unitRate * count - total) <=
    Math.max(1e-9, Math.abs(total) * LINEAR_REL_TOL)
  )
}

/**
 * Per-million rate of one lever, probed below any prompt-size tier
 * (1 and 1,000 tokens), plus whether a million tokens still price
 * linearly. Null when a per-request fee or the like breaks linearity.
 */
function perMillion(
  card: RateCard,
  lever: string,
  zeros: Record<string, number>,
): { rate: number; tiered: boolean } | null {
  const at1 = tryPrice(card, { ...zeros, [lever]: 1 })
  const at1k = tryPrice(card, { ...zeros, [lever]: 1_000 })
  const at1m = tryPrice(card, { ...zeros, [lever]: 1_000_000 })
  if (at1 === null || at1k === null || at1m === null) return null
  if (!linear(at1, 1_000, at1k)) return null
  return { rate: at1 * 1_000_000, tiered: !linear(at1, 1_000_000, at1m) }
}

/** The unit a non-token card's quantity lever counts. */
const UNIT_OF_LEVER: Record<string, CompactPricing['per']> = {
  seconds: 'second',
  audio_seconds: 'second',
  video_seconds: 'second',
  duration: 'second',
  characters: 'character',
  n: 'image',
  num_images: 'image',
  images: 'image',
}

/**
 * List-row summary of a card. A token card gets `inputPerMillion` (and
 * `outputPerMillion` when it prices output) at the base rate, `tiered`
 * when a long prompt re-quotes the request; a token card whose price is
 * not linear in either (a per-request fee) gets `per: 'token'` alone.
 * Other cards name what they bill by, or `unit` when that is not obvious.
 */
export function projectTokenPricing(card: RateCard): CompactPricing {
  if (!isTokenCard(card)) {
    const quantity = Object.values(card.inputs).find(
      (input) => input.kind === 'number',
    )
    return {
      per: quantity ? (UNIT_OF_LEVER[quantity.param] ?? 'unit') : 'request',
    }
  }
  const hasOutput = Object.values(card.inputs).some(
    (input) => input.param === 'output_tokens',
  )
  const zeros: Record<string, number> = hasOutput
    ? { input_tokens: 0, output_tokens: 0 }
    : {}
  const input = perMillion(card, 'input_tokens', zeros)
  const output = hasOutput ? perMillion(card, 'output_tokens', zeros) : null
  if (input === null || (hasOutput && output === null)) return { per: 'token' }
  return {
    per: 'token',
    inputPerMillion: input.rate,
    ...(output && { outputPerMillion: output.rate }),
    ...((input.tiered || output?.tiered) && { tiered: true as const }),
  }
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
