/**
 * POST /v1/estimate — evaluate a stored rate card against a request/usage
 * pair. Thin wrapper around `price` from @modelschemas/rate-card.
 */
import { priceDetailed, RateCardError } from '@modelschemas/rate-card'
import type { RateCard } from '@modelschemas/rate-card'

import type { Db } from '#/db/index.ts'
import { getModelDetail } from '#/server/catalog.ts'
import { parseStoredRateCard } from '#/server/rate-card.ts'

export interface EstimateRequestBody {
  provider: string
  model: string
  request?: Record<string, unknown>
  usage?: Record<string, unknown>
}

export type EstimateOutcome =
  | {
      ok: true
      result: {
        usd: number
        cardSource: RateCard['source']
        /** Omitted params the card estimated; empty means billed price. */
        estimated: string[]
      }
    }
  | { ok: false; status: number; code: string; message: string }

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
  const slot = (entry: { bound?: string; param: string }) =>
    `${entry.bound === 'usage' ? 'usage' : 'request'}.${entry.param}`
  const input =
    (name !== undefined ? card.inputs[name] : undefined) ??
    Object.values(card.inputs).find((entry) => entry.param === name)
  // An input only the estimate reads: name the real value it stands in for.
  const estimated = Object.values(card.inputs).find(
    (entry) =>
      entry.kind === 'number' &&
      entry.estimate &&
      name !== undefined &&
      name in entry.estimate.inputs,
  )
  if (error.code === 'bad-input' && error.message.includes('required')) {
    if (input) {
      return {
        code: 'unbound_input',
        message:
          `Rate card requires ${slot(input)} which was not provided. ` +
          `Pass it on the estimate body. See GET /v1/models/${body.provider}/${body.model}.`,
      }
    }
    const via =
      estimated?.kind === 'number' && name !== undefined
        ? estimated.estimate?.inputs[name]
        : undefined
    if (estimated && via) {
      return {
        code: 'unbound_input',
        message:
          `Rate card requires ${slot(estimated)}, or ${slot(via)} to estimate it. ` +
          `See GET /v1/models/${body.provider}/${body.model}.`,
      }
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
  if (!card) {
    return {
      ok: false,
      status: 404,
      code: 'unknown_pricing',
      message: `No rate card for '${body.provider}/${body.model}'. See GET /v1/models/${body.provider}/${body.model}.`,
    }
  }
  try {
    const { usd, estimated } = priceDetailed(
      card,
      body.request ?? {},
      body.usage ?? {},
    )
    return { ok: true, result: { usd, cardSource: card.source, estimated } }
  } catch (error) {
    if (error instanceof RateCardError) {
      const mapped = mapRateCardError(error, card, body)
      return { ok: false, status: 422, ...mapped }
    }
    throw error
  }
}
