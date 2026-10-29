/**
 * docs.cloud.google.com answers 429 to Workers egress from every colo
 * (issue #517). One response is enough to stop: the rest of this poll
 * reads what KV already has. A stored parse outlives the six-hour fresh
 * window so the listing can still succeed while the host is refusing us.
 * A 429 with nothing stored still fails the poll. Any other status fails
 * closed and does not count as this limit.
 */
import { getJson, putJson } from '#/server/kv.ts'

import { cachedDocs, DOCS_TTL_SECONDS, docsCacheKey } from './model-facts.ts'

const HOST = 'docs.cloud.google.com'
/** Long enough that the next 15-minute poll is the next probe. */
const COOLING_MS = 15 * 60 * 1000
/** Past the fresh window, still short enough to drop a retired page. */
const STALE_TTL_SECONDS = 7 * 24 * 60 * 60

let coolingUntil = 0

export function resetGoogleDocsLimit(): void {
  coolingUntil = 0
}

function staleKey(url: string): string {
  return `docs-stale:${docsCacheKey(url).slice('docs:'.length)}`
}

function isDocsHost(url: string): boolean {
  try {
    return new URL(url).hostname === HOST
  } catch {
    return false
  }
}

/** A fetch skipped because this host already answered 429. */
class GoogleDocsCooling extends Error {
  constructor(url: string) {
    super(`google docs cooling: ${url}`)
    this.name = 'GoogleDocsCooling'
  }
}

function isDocs429(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes(HOST) &&
    error.message.includes('→ 429')
  )
}

function hostLimited(error: unknown): boolean {
  return error instanceof GoogleDocsCooling || isDocs429(error)
}

function noteLimit(): void {
  coolingUntil = Date.now() + COOLING_MS
}

async function rememberStale<T>(
  kv: KVNamespace,
  url: string,
  value: T,
): Promise<void> {
  const key = staleKey(url)
  if ((await kv.get(key, 'text')) !== null) return
  await putJson(kv, key, value, { expirationTtl: STALE_TTL_SECONDS })
}

async function staleOrThrow<T>(
  kv: KVNamespace | undefined,
  url: string,
  error: unknown,
): Promise<T> {
  if (kv) {
    const stale = await getJson<T>(kv, staleKey(url))
    if (stale !== null) return stale
  }
  throw error
}

/**
 * `cachedDocs` for a docs.cloud.google.com page. Other URLs are unchanged.
 * While the host is cooling, a miss is not fetched.
 */
export async function cachedGoogleDocs<T>(
  kv: KVNamespace | undefined,
  url: string,
  load: () => Promise<T>,
): Promise<T> {
  if (!isDocsHost(url)) return cachedDocs(kv, url, load)
  const freshKey = docsCacheKey(url)
  if (kv) {
    const hit = await getJson<T>(kv, freshKey)
    if (hit !== null) {
      await rememberStale(kv, url, hit)
      return hit
    }
  }
  if (Date.now() < coolingUntil) {
    return staleOrThrow(kv, url, new GoogleDocsCooling(url))
  }
  try {
    const value = await load()
    if (kv) {
      await putJson(kv, freshKey, value, { expirationTtl: DOCS_TTL_SECONDS })
      await putJson(kv, staleKey(url), value, {
        expirationTtl: STALE_TTL_SECONDS,
      })
    }
    return value
  } catch (error) {
    if (!hostLimited(error)) throw error
    if (isDocs429(error)) noteLimit()
    return staleOrThrow(kv, url, error)
  }
}
