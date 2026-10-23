/**
 * POST /v1/estimate — evaluate a stored rate card against a request/usage
 * pair. Thin wrapper around `normalizeUsage` and `priceDetailed` from
 * @modelschemas/rate-card, so `usage` is card levers or the provider's own
 * usage object;
 * `estimated` names any input filled by the card's published estimate,
 * `defaulted` any input that took the card's default, and `ignored` any
 * request key the card does not read. A routed id with a `pricingRange`
 * and no card is priced on every route's card and returns `{ min, max }`.
 * A card missing only one required choice input returns `{ byInput }`,
 * one price per allowed value.
 */
import {
  cardCurrency,
  normalizeUsage,
  priceDetailed,
  RateCardError,
} from '@modelschemas/rate-card'
import type { RateCard, RateCardInput } from '@modelschemas/rate-card'

import { and, eq, inArray } from 'drizzle-orm'

import type { Db } from '#/db/index.ts'
import { models } from '#/db/schema.ts'
import { getModelDetail } from '#/server/catalog.ts'
import { parseStoredRateCard } from '#/server/rate-card.ts'
import type { PricingRange } from '#/server/rate-card.ts'

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

/**
 * A card whose one required choice input (enum or boolean, no default)
 * was not supplied (issue #450): the call priced once per allowed value.
 * The bill is the amount for the value the call actually uses.
 */
export interface EstimateByInputResult {
  currency: string
  byInput: {
    /** The param the call omitted. */
    input: string
    /** Each allowed value (booleans as "true"/"false") → its price. */
    values: Record<string, EstimateResult>
  }
}

type EstimateError = {
  ok: false
  status: number
  code: string
  message: string
}

export type EstimateOutcome =
  | {
      ok: true
      result: EstimateResult | EstimateRangeResult | EstimateByInputResult
    }
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
  const input = error.input === undefined ? undefined : card.inputs[error.input]
  const slot = input ? slotOf(input) : undefined
  if (error.code === 'bad-input' && slot) {
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
    return priceRoutes(db, body, model.pricingRange.routes)
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

/** The values a required choice input (enum or boolean, no default) takes. */
function choiceValues(
  input: RateCardInput | undefined,
): Array<string | boolean> | undefined {
  if (input?.kind === 'enum' && input.default === undefined) return input.values
  if (input?.kind === 'boolean' && input.default === undefined) {
    return [true, false]
  }
  return undefined
}

const slotOf = (input: RateCardInput) =>
  `${input.bound === 'usage' ? 'usage' : 'request'}.${input.param}`

/**
 * Price the call. When exactly one required choice input is missing and
 * nothing else is, price it once per allowed value (issue #450); two
 * missing choices, or any missing quantity, refuse.
 */
function priceCard(
  card: RateCard,
  body: EstimateRequestBody,
):
  | { ok: true; result: EstimateResult | EstimateByInputResult }
  | EstimateError {
  const refuse = (error: unknown, prefix = ''): EstimateError => {
    if (!(error instanceof RateCardError)) throw error
    const mapped = mapRateCardError(error, card, body)
    return {
      ok: false,
      status: 422,
      ...mapped,
      message: prefix + mapped.message,
    }
  }
  let request = body.request ?? {}
  let usage: Record<string, unknown>
  try {
    usage = normalizeUsage(card, body.usage ?? {})
  } catch (error) {
    return refuse(error)
  }
  const fill = (name: string, value: unknown) => {
    const input = card.inputs[name]
    if (input?.bound === 'usage') usage = { ...usage, [input.param]: value }
    else if (input) request = { ...request, [input.param]: value }
  }
  const run = (): EstimateResult => ({
    ...priceDetailed(card, request, usage),
    cardSource: card.source,
  })
  // Fill each missing choice with its first value to find every missing
  // input; any other refusal stands, unless it may hang on the value tried.
  const missing: string[] = []
  for (;;) {
    try {
      const result = run()
      if (missing.length === 0) return { ok: true, result }
      break
    } catch (error) {
      const name = error instanceof RateCardError ? error.input : undefined
      const first =
        name === undefined ? undefined : choiceValues(card.inputs[name])?.[0]
      if (name === undefined || first === undefined) {
        // A missing quantity, or nothing missing: refuse as before.
        if (missing.length === 0 || name !== undefined) return refuse(error)
        break // may hang on the value tried; the per-value pass names it
      }
      missing.push(name)
      fill(name, first)
    }
  }
  if (missing.length > 1) {
    const named = missing.map((name) => {
      const input = card.inputs[name] as RateCardInput
      return `${slotOf(input)} (${choiceValues(input)?.join(' | ')})`
    })
    return {
      ok: false,
      status: 422,
      code: 'unbound_input',
      message:
        `Rate card requires ${named.join(' and ')}, which were not provided. ` +
        `Pass them on the estimate body. See GET /v1/models/${body.provider}/${body.model}.`,
    }
  }
  const [name] = missing as [string]
  const input = card.inputs[name] as RateCardInput
  const values: EstimateByInputResult['byInput']['values'] = {}
  for (const value of choiceValues(input) ?? []) {
    fill(name, value)
    try {
      values[String(value)] = run()
    } catch (error) {
      return refuse(error, `With ${slotOf(input)} = ${JSON.stringify(value)}: `)
    }
  }
  return {
    ok: true,
    result: {
      currency: cardCurrency(card),
      byInput: { input: input.param, values },
    },
  }
}

/**
 * Price the call on each route's own stored card. Any route that cannot
 * be priced refuses the whole estimate: without it the bounds are unknown.
 */
async function priceRoutes(
  db: Db,
  body: EstimateRequestBody,
  routes: PricingRange['routes'],
): Promise<EstimateOutcome> {
  const lookups = routes
    .filter((route) => !route.card)
    .map((route) => route.model)
  const rows =
    lookups.length === 0
      ? []
      : await db
          .select({ rawId: models.rawId, pricing: models.pricing })
          .from(models)
          .where(
            and(
              eq(models.providerId, body.provider),
              inArray(models.rawId, lookups),
            ),
          )
  const byRaw = new Map(rows.map((row) => [row.rawId, row.pricing]))
  const priced: Array<EstimateResult & { model: string }> = []
  const names: Array<string> = []
  for (const route of routes) {
    // An inline card is the route (Vercel provider_name). A catalog row
    // is named by its rawId.
    const name = route.provider ?? route.model
    names.push(name)
    const routeBody = { ...body, model: name }
    const card = route.card
      ? parseStoredRateCard(route.card)
      : parseStoredRateCard(byRaw.get(route.model))
    if (!card) return noCard(routeBody)
    const outcome = priceCard(card, routeBody)
    if (!outcome.ok) {
      return { ...outcome, message: `Route ${name}: ${outcome.message}` }
    }
    if ('byInput' in outcome.result) {
      // ponytail: no range-per-value shape yet; nest them if a caller needs it.
      return {
        ok: false,
        status: 422,
        code: 'unbound_input',
        message: `Route ${name}: rate card requires ${outcome.result.byInput.input}, which was not provided. Pass it on the estimate body. See GET /v1/models/${body.provider}/${route.model}.`,
      }
    }
    priced.push({ model: name, ...outcome.result })
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
      message: `The routes of '${body.provider}/${body.model}' price in different currencies; nothing is converted. Estimate one route: ${names.join(', ')}.`,
    }
  }
  return { ok: true, result: { currency, min, max, routes: names } }
}
