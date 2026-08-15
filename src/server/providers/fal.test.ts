import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fetchPageWithRetry } from './fal.ts'

const PAGE = { models: [], has_more: false, next_cursor: null }

function jsonResponse(): Response {
  return new Response(JSON.stringify(PAGE), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function errorResponse(
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response('nope', { status, headers })
}

/** Resolve the retry loop's backoff sleeps as they are scheduled. */
async function withTimersFlushed<T>(promise: Promise<T>): Promise<T> {
  // Mark handled before the flush: a rejection landing mid-flush would
  // otherwise trip the unhandled-rejection detector.
  void promise.catch(() => undefined)
  await vi.runAllTimersAsync()
  return promise
}

describe('fetchPageWithRetry', () => {
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('returns the parsed page on success', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse())
    await expect(fetchPageWithRetry('https://x', 'key')).resolves.toEqual(PAGE)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries 429 (with Retry-After) and 5xx before succeeding', async () => {
    fetchMock
      .mockResolvedValueOnce(errorResponse(429, { 'Retry-After': '1' }))
      .mockResolvedValueOnce(errorResponse(503))
      .mockResolvedValueOnce(jsonResponse())
    await expect(
      withTimersFlushed(fetchPageWithRetry('https://x', 'key')),
    ).resolves.toEqual(PAGE)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('retries network-level failures', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('connection reset'))
      .mockResolvedValueOnce(jsonResponse())
    await expect(
      withTimersFlushed(fetchPageWithRetry('https://x', 'key')),
    ).resolves.toEqual(PAGE)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('fails fast on non-retryable statuses like 401', async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(401))
    await expect(fetchPageWithRetry('https://x', 'key')).rejects.toThrow(
      'fal models fetch failed: 401',
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('gives up after the attempt budget with the last failure in the message', async () => {
    fetchMock.mockResolvedValue(errorResponse(429))
    await expect(
      withTimersFlushed(fetchPageWithRetry('https://x', 'key', 3)),
    ).rejects.toThrow('fal models fetch failed after 3 attempts: 429')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})
