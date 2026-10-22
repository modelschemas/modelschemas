/**
 * POST /v1/estimate — evaluate a stored rate card against a request/usage
 * pair. Thin wrapper around `normalizeUsage` and `priceDetailed` from
 * @modelschemas/rate-card, so `usage` is card levers or the provider's own
 * usage object;
 * `estimated` names any input filled by the card's published estimate,
 * `defaulted` any input that took the card's default, and `ignored` any
 * request key the card does not read. A routed id with a `pricingRange`
 * and no card is priced on every route's card and returns `{ min, max }`.
 */
import {
  normalizeUsage,
  priceDetailed,
  RateCardError,
} from '@modelschemas/rate-card'
import type { RateCard } from '@modelschemas/rate-card'

import { and, eq, inArray } from 'drizzle-orm'

import type { Db } from '#/db/index.ts'
import { models } from '#/db/schema.ts'
import { getModelDetail } from '#/server/catalog.ts'
import { parseStoredRateCard } from '#/server/rate-card.ts'

export interface EstimateRequestBody {
  provider: string
  model: string
  request?: Record<string, unknown>
  usage?: Record<string, unknown>
}

export interface EstimateResult {
  /** The price, in `currency` (ISO 4217). Never converted. */
  amount: number
  currency: string
  /** `amount` again for a USD card; absent for any other currency. */
  usd?: number
  cardSource: RateCard['source']
  /** Omitted params the card estimated; empty means billed price. */
  estimated: string[]
  /** Omitted params that took the card's default value. */
  defaulted: string[]
  /** Request keys the card does not read. */
  ignored: string[]
}

/**
 * A routed id with no single billed price (issue #406): the call priced
 * on every route's card. The bill is one route's amount, somewhere in
 * [min, max]; neither end is the billed price.
 */
export interface EstimateRangeResult {
  currency: string
  min: EstimateResult & { model: string }
  max: EstimateResult & { model: string }
  /** Every route priced, as model ids under the same provider. */
  routes: string[]
}

type EstimateError = {
  ok: false
  status: number
  code: string
  message: string
}

export type EstimateOutcome =
  | { ok: true; result: EstimateResult | EstimateRangeResult }
  | EstimateError

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export function parseEstimateBody(raw: unknown): EstimateRequestBody | null {
  if (!isRecord(raw)) return null
  if (typeof raw.provider !== 'string' || typeof raw.model !== 'string') {
    return null
  }
  if (raw.request !== undefined && !isRecord(raw.request)) return null
  if (raw.usage !== undefined && !isRecord(raw.usage)) return null
  return {
    provider: raw.provider,
    model: raw.model,
    request: raw.request,
    usage: raw.usage,
  }
}

function mapRateCardError(
  error: RateCardError,
  card: RateCard,
  body: EstimateRequestBody,
): { code: string; message: string } {
  const name = error.message.split(/[\s(]/)[0]
  const input =
    (name !== undefined ? card.inputs[name] : undefined) ??
    Object.values(card.inputs).find((entry) => entry.param === name)
  const slot = input
    ? `${input.bound === 'usage' ? 'usage' : 'request'}.${input.param}`
    : undefined
  if (
    error.code === 'bad-input' &&
    error.message.includes('required') &&
    slot
  ) {
    return {
      code: 'unbound_input',
      message:
        `Rate card requires ${slot} which was not provided. ` +
        `Pass it on the estimate body. See GET /v1/models/${body.provider}/${body.model}.`,
    }
  }
  if (error.code === 'estimate-unavailable' && slot) {
    return {
      code: 'unbound_input',
      message:
        `Rate card requires ${slot}; it was not provided and could not be estimated (${error.message}). ` +
        `Pass it on the estimate body. See GET /v1/models/${body.provider}/${body.model}.`,
    }
  }
  return {
    code: error.code.replaceAll('-', '_'),
    message:
      `${error.message}. Check request/usage against the model's rate card ` +
      `at GET /v1/models/${body.provider}/${body.model}.`,
  }
}

export async function estimateCost(
  db: Db,
  body: EstimateRequestBody,
): Promise<EstimateOutcome> {
  const model = await getModelDetail(db, body.provider, body.model)
  if (!model) {
    return {
      ok: false,
      status: 404,
      code: 'unknown_model',
      message: `Unknown model '${body.model}' for provider '${body.provider}'. Try GET /v1/providers/${body.provider}/models for valid ids.`,
    }
  }
  const card = parseStoredRateCard(model.pricing)
  if (card) return priceCard(card, body)
  if (model.pricingRange) {
    return priceRoutes(
      db,
      body,
      model.pricingRange.routes.map((route) => route.model),
    )
  }
  return noCard(body)
}

function noCard(body: EstimateRequestBody): EstimateError {
  return {
    ok: false,
    status: 404,
    code: 'unknown_pricing',
    message: `No rate card for '${body.provider}/${body.model}'. See GET /v1/models/${body.provider}/${body.model}.`,
  }
}

function priceCard(
  card: RateCard,
  body: EstimateRequestBody,
): { ok: true; result: EstimateResult } | EstimateError {
  try {
    const result = priceDetailed(
      card,
      body.request ?? {},
      normalizeUsage(card, body.usage ?? {}),
    )
    return { ok: true, result: { ...result, cardSource: card.source } }
  } catch (error) {
    if (error instanceof RateCardError) {
      const mapped = mapRateCardError(error, card, body)
      return { ok: false, status: 422, ...mapped }
    }
    throw error
  }
}

/**
 * Price the call on each route's own stored card. Any route that cannot
 * be priced refuses the whole estimate: without it the bounds are unknown.
 */
async function priceRoutes(
  db: Db,
  body: EstimateRequestBody,
  routes: Array<string>,
): Promise<EstimateOutcome> {
  const rows = await db
    .select({ rawId: models.rawId, pricing: models.pricing })
    .from(models)
    .where(
      and(eq(models.providerId, body.provider), inArray(models.rawId, routes)),
    )
  const byRaw = new Map(rows.map((row) => [row.rawId, row.pricing]))
  const priced: Array<EstimateResult & { model: string }> = []
  for (const route of routes) {
    const routeBody = { ...body, model: route }
    const card = parseStoredRateCard(byRaw.get(route))
    if (!card) return noCard(routeBody)
    const outcome = priceCard(card, routeBody)
    if (!outcome.ok) {
      return { ...outcome, message: `Route ${route}: ${outcome.message}` }
    }
    priced.push({ model: route, ...outcome.result })
  }
  const byAmount = [...priced].sort((a, b) => a.amount - b.amount)
  const min = byAmount[0]
  const max = byAmount.at(-1)
  if (!min || !max) return noCard(body)
  const currency = min.currency
  if (priced.some((route) => route.currency !== currency)) {
    return {
      ok: false,
      status: 422,
      code: 'mixed_currency',
      message: `The routes of '${body.provider}/${body.model}' price in different currencies; nothing is converted. Estimate one route: ${routes.join(', ')}.`,
    }
  }
  return { ok: true, result: { currency, min, max, routes } }
}
