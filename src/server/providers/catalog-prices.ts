/**
 * Rate cards from numbers a `/models` row already publishes (issue #109).
 * A missing unit, a zero quote, or a tier the row says is not flat stays
 * null. Nothing here invents a price.
 */
import { compileTokenCard } from '@modelschemas/rate-card'
import type { RateCard } from '@modelschemas/rate-card'

import { sha256Text } from './types.ts'

async function tokenCard(
  rates: Record<string, number>,
  url: string,
  raw: unknown,
): Promise<RateCard | null> {
  const priced: Record<string, number> = {}
  for (const [key, value] of Object.entries(rates)) {
    if (Number.isFinite(value) && value > 0) priced[key] = value
  }
  return compileTokenCard(priced, [], {
    url,
    hash: await sha256Text(JSON.stringify(raw)),
    extractedAt: new Date().toISOString(),
  })
}

function decimalPerMillion(node: unknown): number | null {
  if (node === null || typeof node !== 'object') return null
  const value = (node as { price_per_m_decimal?: unknown }).price_per_m_decimal
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value)) return null
  return Number(value) / 1e6
}

/** Novita `pricing.*.price_per_m_decimal` is USD per million tokens. */
export async function novitaListingCard(
  pricing: unknown,
  tiered: boolean | undefined,
  url: string,
): Promise<RateCard | null> {
  if (tiered || pricing === null || typeof pricing !== 'object') return null
  const row = pricing as Record<string, unknown>
  const rates: Record<string, number> = {}
  const input = decimalPerMillion(row.prompt)
  const output = decimalPerMillion(row.completion)
  const cacheRead = decimalPerMillion(row.input_cache_read)
  const cacheWrite = decimalPerMillion(row.input_cache_write)
  if (input !== null) rates.input_tokens = input
  if (output !== null) rates.output_tokens = output
  if (cacheRead !== null) rates.cache_read_tokens = cacheRead
  if (cacheWrite !== null) rates.cache_write_tokens = cacheWrite
  return tokenCard(rates, url, pricing)
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Perplexity quotes USD per million and names the unit on the row. */
export async function perplexityListingCard(
  pricing: unknown,
  url: string,
): Promise<RateCard | null> {
  if (pricing === null || typeof pricing !== 'object') return null
  const row = pricing as Record<string, unknown>
  if (row.unit !== 'usd_per_1m_tokens') return null
  const rates: Record<string, number> = {}
  const input = finite(row.input)
  const output = finite(row.output)
  const cacheRead = finite(row.cache_read)
  const cacheWrite = finite(row.cache_write)
  if (input !== null) rates.input_tokens = input / 1e6
  if (output !== null) rates.output_tokens = output / 1e6
  if (cacheRead !== null) rates.cache_read_tokens = cacheRead / 1e6
  if (cacheWrite !== null) rates.cache_write_tokens = cacheWrite / 1e6
  return tokenCard(rates, url, pricing)
}

function perToken(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value)) {
    return Number(value)
  }
  return null
}

/**
 * Jina and SambaNova `pricing.prompt` / `completion` are USD per token
 * (a per-million reading of `0.00000005` is not a published rate).
 */
export async function perTokenListingCard(
  pricing: unknown,
  url: string,
): Promise<RateCard | null> {
  if (pricing === null || typeof pricing !== 'object') return null
  const row = pricing as Record<string, unknown>
  const rates: Record<string, number> = {}
  const input = perToken(row.prompt)
  const output = perToken(row.completion)
  const cacheRead = perToken(row.input_cache_read)
  const cacheWrite = perToken(row.input_cache_write)
  if (input !== null) rates.input_tokens = input
  if (output !== null) rates.output_tokens = output
  if (cacheRead !== null) rates.cache_read_tokens = cacheRead
  if (cacheWrite !== null) rates.cache_write_tokens = cacheWrite
  return tokenCard(rates, url, pricing)
}

/**
 * Hyperbolic `input_price` / `output_price` are USD per million tokens.
 * The same numbers as per-token rates would be dollars per single token.
 */
export async function hyperbolicListingCard(
  input: unknown,
  output: unknown,
  url: string,
): Promise<RateCard | null> {
  const rates: Record<string, number> = {}
  if (typeof input === 'number') rates.input_tokens = input / 1e6
  if (typeof output === 'number') rates.output_tokens = output / 1e6
  return tokenCard(rates, url, { input, output })
}
