/**
 * HTTP cache semantics for read endpoints (PLAN.md task 3.2): `ETag`
 * (content hash), `Last-Modified`, `Cache-Control` with
 * stale-while-revalidate, `X-Fetched-At` / `X-Stale-At` (unix epoch
 * seconds), and `If-None-Match` → 304. Applied to every schema/model read
 * endpoint in Phase 4.
 */
import { contentHash } from '#/server/kv.ts'

export interface CacheHeaderOptions {
  /** Content hash to use as the ETag; computed from the body when omitted. */
  etag?: string
  /** Unix epoch seconds the value was fetched/produced. */
  fetchedAt: number
  /** Unix epoch seconds the value goes stale. */
  staleAt: number
  /** Cache-Control max-age (seconds). */
  maxAge?: number
  /** Cache-Control stale-while-revalidate window (seconds). */
  staleWhileRevalidate?: number
}

function buildHeaders(
  etag: string,
  options: CacheHeaderOptions,
  contentType: string,
): Headers {
  return new Headers({
    'Content-Type': contentType,
    ETag: `"${etag}"`,
    'Last-Modified': new Date(options.fetchedAt * 1000).toUTCString(),
    'Cache-Control': `public, max-age=${String(options.maxAge ?? 60)}, stale-while-revalidate=${String(options.staleWhileRevalidate ?? 600)}`,
    'X-Fetched-At': String(options.fetchedAt),
    'X-Stale-At': String(options.staleAt),
  })
}

/** RFC 9110 If-None-Match: comma-separated entity tags, `W/` prefixes
 * compare weakly, `*` matches anything. */
export function ifNoneMatchSatisfied(
  header: string | null,
  etag: string,
): boolean {
  if (!header) return false
  if (header.trim() === '*') return true
  return header
    .split(',')
    .map((tag) => tag.trim().replace(/^W\//, ''))
    .includes(`"${etag}"`)
}

/**
 * JSON response with full cache semantics; returns 304 (no body, same
 * headers) when the request's If-None-Match matches the ETag.
 */
export async function cachedJson(
  request: Request,
  value: unknown,
  options: CacheHeaderOptions,
): Promise<Response> {
  const etag = options.etag ?? (await contentHash(value))
  return respond(
    request,
    JSON.stringify(value),
    etag,
    options,
    'application/json',
  )
}

/** Same cache semantics for a non-JSON text body (e.g. `?format=types`). */
export function cachedText(
  request: Request,
  body: string,
  contentType: string,
  options: CacheHeaderOptions & { etag: string },
): Response {
  return respond(request, body, options.etag, options, contentType)
}

function respond(
  request: Request,
  body: string,
  etag: string,
  options: CacheHeaderOptions,
  contentType: string,
): Response {
  const headers = buildHeaders(etag, options, contentType)
  if (ifNoneMatchSatisfied(request.headers.get('if-none-match'), etag)) {
    headers.delete('Content-Type')
    return new Response(null, { status: 304, headers })
  }
  return new Response(body, { status: 200, headers })
}
