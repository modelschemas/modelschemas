import { describe, expect, it } from 'vitest'

import { assertParsed } from '#/server/providers/model-facts.ts'

import {
  POSTHOG_CAPTURE_URL,
  captureIngestEvents,
  ingestFailedEvent,
  noteIngest,
  observePricingWrite,
  parseRowsEvent,
  posthogBatch,
  runIngestScope,
  takeIngestEvents,
} from './ingest-signals.ts'

describe('observePricingWrite', () => {
  it('keeps a stored card and emits pricing_lost when the parser misses the row', () => {
    expect(
      observePricingWrite({
        providerId: 'byteplus',
        rawId: 'seedream-5-0-pro',
        incomingNull: true,
        hadStoredCard: true,
        keepExtracted: false,
      }),
    ).toEqual({
      keepPrior: true,
      failure: 1,
      events: [
        {
          event: 'pricing_lost',
          properties: {
            providerId: 'byteplus',
            rawId: 'seedream-5-0-pro',
            reason: 'parser_miss',
          },
        },
      ],
    })
  })

  it('does not treat a FAL docs-extracted keep as a loss', () => {
    expect(
      observePricingWrite({
        providerId: 'fal',
        rawId: 'fal-ai/flux',
        incomingNull: true,
        hadStoredCard: true,
        keepExtracted: true,
      }),
    ).toEqual({ keepPrior: true, events: [], failure: 0 })
  })

  it('obeys a stated reason quietly: cleared drops the card, unavailable keeps it', () => {
    const lost = {
      providerId: 'huggingface',
      rawId: 'a/b',
      incomingNull: true,
      hadStoredCard: true,
    }
    // `cleared` beats even the FAL docs-extracted keep.
    expect(
      observePricingWrite({ ...lost, keepExtracted: true, absent: 'cleared' }),
    ).toEqual({ keepPrior: false, events: [], failure: 0 })
    expect(
      observePricingWrite({
        ...lost,
        keepExtracted: false,
        absent: 'unavailable',
      }),
    ).toEqual({ keepPrior: true, events: [], failure: 0 })
  })

  it('emits rate_card_refused when a stored card fails the write gate', () => {
    const decision = observePricingWrite({
      providerId: 'byteplus',
      rawId: 'seedream-5-0-pro',
      incomingNull: false,
      hadStoredCard: true,
      keepExtracted: false,
      refused: 'invented_param',
    })
    expect(decision.keepPrior).toBe(false)
    expect(decision.failure).toBe(1)
    expect(decision.events).toEqual([
      {
        event: 'rate_card_refused',
        properties: {
          providerId: 'byteplus',
          rawId: 'seedream-5-0-pro',
          reason: 'invented_param',
        },
      },
    ])
  })

  it('stays quiet for an uncompilable listing that never had a card', () => {
    expect(
      observePricingWrite({
        providerId: 'openrouter',
        rawId: 'openrouter/auto',
        incomingNull: false,
        hadStoredCard: false,
        keepExtracted: false,
        refused: 'uncompilable',
      }).events,
    ).toEqual([])
  })
})

describe('posthog capture', () => {
  it('batches a zero-row poll failure without putting the key in properties', () => {
    const body = posthogBatch(
      [
        ingestFailedEvent(
          'models-poll',
          'byteplus',
          'byteplus pricing page: parsed 0 model rows',
        ),
      ],
      'phc_test',
    )
    expect(body.api_key).toBe('phc_test')
    expect(body.batch).toEqual([
      {
        event: 'ingest_failed',
        distinct_id: 'modelschemas',
        properties: {
          job: 'models-poll',
          providerId: 'byteplus',
          error: 'byteplus pricing page: parsed 0 model rows',
        },
      },
    ])
    expect(JSON.stringify(body.batch)).not.toContain('phc_test')
  })

  it('records parse_rows from assertParsed and still captures if PostHog throws', async () => {
    takeIngestEvents()
    assertParsed(new Map([['seedream-5-0', 1]]), 'byteplus pricing page')
    const calls: Array<[string, RequestInit | undefined]> = []
    const fetchImpl: typeof fetch = (input, init) => {
      calls.push([String(input), init])
      return Promise.reject(new Error('down'))
    }
    await expect(
      captureIngestEvents('phc_test', fetchImpl),
    ).resolves.toBeUndefined()
    expect(calls[0]?.[0]).toBe(POSTHOG_CAPTURE_URL)
    expect(calls[0]?.[1]?.method).toBe('POST')
    const body = JSON.parse(String(calls[0]?.[1]?.body)) as {
      batch: Array<{ event: string; properties: { rows: number } }>
    }
    expect(body.batch[0]).toMatchObject({
      event: 'parse_rows',
      properties: { source: 'byteplus pricing page', rows: 1 },
    })
  })

  it('keeps overlapping scopes from mixing events', async () => {
    takeIngestEvents()
    const outer = runIngestScope(async () => {
      noteIngest(parseRowsEvent('outer', 1))
      const inner = await runIngestScope(async () => {
        noteIngest(parseRowsEvent('inner', 2))
        return takeIngestEvents()
      })
      return { inner, outer: takeIngestEvents() }
    })
    const taken = await outer
    expect(taken.inner).toEqual([parseRowsEvent('inner', 2)])
    expect(taken.outer).toEqual([parseRowsEvent('outer', 1)])
    expect(takeIngestEvents()).toEqual([])
  })

  it('passes an abort signal so a hung PostHog capture cannot stall the cron', async () => {
    takeIngestEvents()
    noteIngest(parseRowsEvent('page', 1))
    const fetchImpl: typeof fetch = (_input, init) => {
      expect(init?.signal?.aborted).toBe(false)
      return Promise.reject(new Error('down'))
    }
    await expect(
      captureIngestEvents('phc_test', fetchImpl),
    ).resolves.toBeUndefined()
  })

  it('assertParsed throws on zero rows and does not emit parse_rows', () => {
    takeIngestEvents()
    expect(() => assertParsed(new Map(), 'gemini pricing page')).toThrow(
      /parsed 0 model rows/,
    )
    expect(takeIngestEvents()).toEqual([])
  })
})
