/**
 * Daily Vercel route-price extract (issue #451). Rows whose listing says
 * `pricing.varies_by_provider` have no single billed price. Each route's
 * price is on `GET /v1/models/{id}/endpoints`. That is one request per
 * model, so it runs on its own cron, never inside the 15-minute poll.
 *
 * An endpoint with `status` other than 0 is not billed right now, so it
 * is left out of the range. The fact source names every skipped route.
 * A route with no readable linear price, a tier, or a different currency
 * refuses the whole range (null, never a partial). A failed fetch keeps
 * the stored range.
 */
import { and, eq, isNull } from 'drizzle-orm'
import { compileOpenRouterPricing } from '@modelschemas/rate-card'
import type { RateCard } from '@modelschemas/rate-card'

import { changes, models } from '#/db/schema.ts'
import { errorMessage } from '#/server/errors.ts'
import { VERCEL_MODELS_URL } from '#/server/providers/adapters/vercel.ts'
import { fetchJson, sha256Text } from '#/server/providers/types.ts'
import type { ModelFactSources } from '#/server/providers/types.ts'
import { pricingRange } from '#/server/rate-card.ts'
import type { PricingRange } from '#/server/rate-card.ts'
import { changedFactPaths, modelUpdatedPayload } from './change-facts.ts'
import {
  captureIngestEvents,
  ingestFailedEvent,
  noteIngest,
  runIngestScope,
} from './ingest-signals.ts'
import type { SyncDeps } from './sync.ts'

/** Once a day, before the 05:00 spec-sync shards. Own invocation budget. */
export const VERCEL_PRICING_EXTRACT_CRON = '0 4 * * *'

const JOB = 'vercel-pricing-extract' as const

export interface VercelPricingExtractOutcome {
  candidates: number
  fetched: number
  ranged: number
  refused: number
  unchanged: number
  fetchFailed: number
  error?: string
}

interface EndpointRoute {
  provider: string
  pricing: unknown
  status: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function vercelEndpointsUrl(rawId: string): string {
  return `${VERCEL_MODELS_URL}/${rawId}/endpoints`
}

/**
 * Available routes (`status === 0`) become a range. Anything else is
 * named in `skipped` and left out. `null` range means the payload was
 * readable and is not a range: unreadable price, a tier, one route, or
 * mixed currency. A payload that is not the endpoints document throws.
 */
export function compileVercelEndpointRange(
  rawId: string,
  payload: unknown,
  source: RateCard['source'],
): { range: PricingRange | null; skipped: Array<string> } {
  const data = isRecord(payload) ? payload.data : undefined
  const endpoints = isRecord(data) ? data.endpoints : undefined
  if (!Array.isArray(endpoints)) {
    throw new Error(`vercel: ${rawId} endpoints payload has no data.endpoints`)
  }
  const available: Array<EndpointRoute> = []
  const skipped: Array<string> = []
  for (const endpoint of endpoints) {
    if (!isRecord(endpoint)) {
      throw new Error(`vercel: ${rawId} endpoint is not an object`)
    }
    if (typeof endpoint.status !== 'number') {
      throw new Error(`vercel: ${rawId} endpoint status is not a number`)
    }
    const provider =
      typeof endpoint.provider_name === 'string' ? endpoint.provider_name : null
    if (!provider) {
      throw new Error(`vercel: ${rawId} endpoint has no provider_name`)
    }
    if (endpoint.status !== 0) {
      skipped.push(provider)
      continue
    }
    available.push({ provider, pricing: endpoint.pricing, status: 0 })
  }
  const compiled = available.map((route) => ({
    model: route.provider,
    provider: route.provider,
    card: compileOpenRouterPricing(route.pricing, source),
  }))
  return { range: pricingRange(compiled), skipped }
}

/** Path that states the status filter and every route it dropped. */
export function vercelRangePath(skipped: Array<string>): string {
  const kept = 'data.endpoints[status=0].pricing'
  if (skipped.length === 0) return kept
  return `${kept}; skipped status!=0: ${skipped.join(', ')}`
}

/** Prices only. Uptime and latency on the same document are not a price change. */
function endpointPrices(payload: unknown): Array<{
  provider: string
  status: number
  pricing: unknown
}> {
  const data = isRecord(payload) ? payload.data : undefined
  const endpoints = isRecord(data) ? data.endpoints : undefined
  if (!Array.isArray(endpoints)) return []
  return endpoints.map((endpoint) => {
    if (!isRecord(endpoint)) return { provider: '', status: -1, pricing: null }
    return {
      provider:
        typeof endpoint.provider_name === 'string'
          ? endpoint.provider_name
          : '',
      status: typeof endpoint.status === 'number' ? endpoint.status : -1,
      pricing: endpoint.pricing ?? null,
    }
  })
}

/**
 * A route whose published per-million rates did not move keeps the stored
 * card clock, so a daily refetch does not emit `model.updated`.
 */
function reuseRouteClocks(
  range: PricingRange | null,
  prior: PricingRange | null,
): PricingRange | null {
  if (!range || !prior) return range
  for (const route of range.routes) {
    if (!route.card) continue
    const old = prior.routes.find((item) => item.provider === route.provider)
    if (!old?.card) continue
    if (JSON.stringify(route.pricing) !== JSON.stringify(old.pricing)) continue
    route.card = { ...route.card, source: { ...old.card.source } }
  }
  return range
}

function sourceOf(url: string, hash: string, now: number): RateCard['source'] {
  return { url, hash, extractedAt: new Date(now * 1000).toISOString() }
}

function asFacts(value: unknown): ModelFactSources | null {
  if (!isRecord(value)) return null
  return value
}

export async function extractVercelPricing(
  deps: SyncDeps,
): Promise<VercelPricingExtractOutcome> {
  return runIngestScope(() => extractVercelPricingScoped(deps))
}

async function extractVercelPricingScoped(
  deps: SyncDeps,
): Promise<VercelPricingExtractOutcome> {
  const outcome: VercelPricingExtractOutcome = {
    candidates: 0,
    fetched: 0,
    ranged: 0,
    refused: 0,
    unchanged: 0,
    fetchFailed: 0,
  }
  const now = Math.floor(Date.now() / 1000)
  try {
    const listing = await fetchJson(VERCEL_MODELS_URL)
    if (!isRecord(listing) || !Array.isArray(listing.data)) {
      throw new Error('vercel: models payload has no data array')
    }
    const varies = new Set<string>()
    for (const row of listing.data) {
      if (!isRecord(row) || typeof row.id !== 'string') continue
      const pricing = isRecord(row.pricing) ? row.pricing : null
      if (pricing?.varies_by_provider === true) varies.add(row.id)
    }
    const live = await deps.db
      .select({
        id: models.id,
        rawId: models.rawId,
        pricingRange: models.pricingRange,
        factSources: models.factSources,
      })
      .from(models)
      .where(and(eq(models.providerId, 'vercel'), isNull(models.deprecatedAt)))
    const targets = live.filter((row) => varies.has(row.rawId))
    outcome.candidates = targets.length
    for (const row of targets) {
      const url = vercelEndpointsUrl(row.rawId)
      let payload: unknown
      try {
        payload = await fetchJson(url)
        outcome.fetched++
      } catch (error) {
        outcome.fetchFailed++
        const message = errorMessage(error)
        console.error(
          JSON.stringify({
            job: JOB,
            providerId: 'vercel',
            rawId: row.rawId,
            error: message,
          }),
        )
        noteIngest(ingestFailedEvent(JOB, 'vercel', message, row.rawId))
        continue
      }
      let compiled: { range: PricingRange | null; skipped: Array<string> }
      try {
        const priced = endpointPrices(payload)
        compiled = compileVercelEndpointRange(
          row.rawId,
          payload,
          sourceOf(url, await sha256Text(JSON.stringify(priced)), now),
        )
        compiled.range = reuseRouteClocks(compiled.range, row.pricingRange)
      } catch (error) {
        outcome.refused++
        noteIngest(
          ingestFailedEvent(JOB, 'vercel', errorMessage(error), row.rawId),
        )
        continue
      }
      const priorFacts = asFacts(row.factSources)
      const nextFacts: ModelFactSources = { ...(priorFacts ?? {}) }
      if (compiled.range) {
        nextFacts.pricingRange = {
          derivation: 'listing',
          sourceUrl: url,
          sourceHash: await sha256Text(
            JSON.stringify({
              routes: compiled.range.routes.map((route) => ({
                provider: route.provider,
                pricing: route.pricing,
              })),
              skipped: compiled.skipped,
            }),
          ),
          path: vercelRangePath(compiled.skipped),
        }
      } else {
        delete nextFacts.pricingRange
      }
      const before = {
        pricingRange: row.pricingRange,
        factSources: priorFacts,
      }
      const after = {
        pricingRange: compiled.range,
        factSources: Object.keys(nextFacts).length > 0 ? nextFacts : null,
      }
      const changed = changedFactPaths(before, after)
      if (changed.length === 0) {
        outcome.unchanged++
        if (compiled.range) outcome.ranged++
        else outcome.refused++
        continue
      }
      await deps.db
        .update(models)
        .set({
          pricingRange: compiled.range,
          factSources: after.factSources,
          lastSeenAt: now,
        })
        .where(eq(models.id, row.id))
      await deps.db.insert(changes).values({
        id: crypto.randomUUID(),
        type: 'model.updated',
        providerId: 'vercel',
        subjectId: row.id,
        summary: `Model ${row.rawId} updated`,
        payload: modelUpdatedPayload(before, after, changed),
        createdAt: now,
      })
      if (compiled.range) outcome.ranged++
      else outcome.refused++
    }
    console.log(JSON.stringify({ job: JOB, ...outcome }))
    return outcome
  } catch (error) {
    outcome.error = errorMessage(error)
    console.error(JSON.stringify({ job: JOB, error: outcome.error }))
    noteIngest(ingestFailedEvent(JOB, 'vercel', outcome.error))
    return outcome
  } finally {
    await captureIngestEvents(deps.secrets.POSTHOG_PROJECT_KEY)
  }
}
