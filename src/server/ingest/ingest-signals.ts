/**
 * Failure signals for docs parses and ingest jobs (issue #104).
 * Builders are pure. `captureIngestEvents` posts them to PostHog US and
 * never throws — a dead analytics host must not fail a cron.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

import { errorMessage } from '#/server/errors.ts'

export const POSTHOG_CAPTURE_URL = 'https://us.i.posthog.com/batch/'
const DISTINCT_ID = 'modelschemas'

export type IngestJob =
  | 'models-poll'
  | 'spec-sync'
  | 'fal-pricing-extract'
  | 'same-as-reconcile'

export type IngestEvent =
  | {
      event: 'ingest_failed'
      properties: { job: IngestJob; providerId: string; error: string }
    }
  | {
      event: 'pricing_lost'
      properties: { providerId: string; rawId: string; reason: string }
    }
  | {
      event: 'rate_card_refused'
      properties: { providerId: string; rawId: string; reason: string }
    }
  | {
      event: 'parse_rows'
      properties: { source: string; rows: number }
    }

export interface PostHogBatch {
  api_key: string
  batch: Array<{
    event: IngestEvent['event']
    distinct_id: string
    properties: IngestEvent['properties']
  }>
}

const pending: Array<IngestEvent> = []
const scopes = new AsyncLocalStorage<Array<IngestEvent>>()

/** One buffer per poll, sync, or extract call so overlapping crons do not mix events. */
export function runIngestScope<T>(fn: () => Promise<T>): Promise<T> {
  return scopes.run([], fn)
}

export function noteIngest(event: IngestEvent): void {
  const scope = scopes.getStore()
  ;(scope ?? pending).push(event)
}

export function takeIngestEvents(): Array<IngestEvent> {
  const scope = scopes.getStore()
  return (scope ?? pending).splice(0)
}

export function ingestFailedEvent(
  job: IngestJob,
  providerId: string,
  error: string,
): IngestEvent {
  return { event: 'ingest_failed', properties: { job, providerId, error } }
}

export function parseRowsEvent(source: string, rows: number): IngestEvent {
  return { event: 'parse_rows', properties: { source, rows } }
}

export interface PricingWriteInput {
  providerId: string
  rawId: string
  /** Fresh listing/docs pricing was null or omitted. */
  incomingNull: boolean
  hadStoredCard: boolean
  /** FAL keeps a `docs-extracted` card the listing never carries. */
  keepExtracted: boolean
  refused?: string
}

export interface PricingWriteDecision {
  /** Keep the stored card instead of writing null. */
  keepPrior: boolean
  events: Array<IngestEvent>
  /** Counted on the poll outcome. 0 or 1. */
  failure: number
}

/**
 * A docs parser that yields nothing for one model used to null its stored
 * card with no signal. Keep the card (same as FAL's docs-extracted rows)
 * and emit `pricing_lost`. A write-gate refusal still nulls the card and
 * emits `rate_card_refused`. Uncompilable listings with no stored card
 * stay quiet — that is the normal OpenRouter zero-price case.
 */
export function observePricingWrite(
  input: PricingWriteInput,
): PricingWriteDecision {
  if (input.keepExtracted) {
    return { keepPrior: true, events: [], failure: 0 }
  }
  if (input.refused) {
    if (input.refused === 'uncompilable' && !input.hadStoredCard) {
      return { keepPrior: false, events: [], failure: 0 }
    }
    return {
      keepPrior: false,
      events: [
        {
          event: 'rate_card_refused',
          properties: {
            providerId: input.providerId,
            rawId: input.rawId,
            reason: input.refused,
          },
        },
      ],
      failure: 1,
    }
  }
  if (input.incomingNull && input.hadStoredCard) {
    return {
      keepPrior: true,
      events: [
        {
          event: 'pricing_lost',
          properties: {
            providerId: input.providerId,
            rawId: input.rawId,
            reason: 'parser_miss',
          },
        },
      ],
      failure: 1,
    }
  }
  return { keepPrior: false, events: [], failure: 0 }
}

export function posthogBatch(
  events: Array<IngestEvent>,
  apiKey: string,
): PostHogBatch {
  return {
    api_key: apiKey,
    batch: events.map((event) => ({
      event: event.event,
      distinct_id: DISTINCT_ID,
      properties: event.properties,
    })),
  }
}

export async function captureIngestEvents(
  apiKey: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const events = takeIngestEvents()
  if (!apiKey || events.length === 0) return
  try {
    const response = await fetchImpl(POSTHOG_CAPTURE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(posthogBatch(events, apiKey)),
      signal: AbortSignal.timeout(5_000),
    })
    if (!response.ok) {
      console.error(
        JSON.stringify({ job: 'posthog', error: `capture ${response.status}` }),
      )
    }
  } catch (error) {
    console.error(
      JSON.stringify({ job: 'posthog', error: errorMessage(error) }),
    )
  }
}
