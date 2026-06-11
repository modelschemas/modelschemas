/**
 * Rate limiting (PLAN.md task 5.4) — fixed-window counters in KV (the
 * Workers Rate Limiting binding only supports 10s/60s periods, not hourly
 * windows). Anonymous traffic: 60 req/h per IP; authenticated: 5k req/h per
 * credential. KV counters are eventually consistent, so bursts may slightly
 * over/under-count — this is abuse mitigation, not billing.
 */
import { importJWK, jwtVerify } from 'jose'
import { eq } from 'drizzle-orm'
import type { JWK } from 'jose'

import { agent } from '#/db/schema.ts'
import type { Db } from '#/db/index.ts'
import type { Auth } from '#/lib/auth.ts'

export const ANONYMOUS_LIMIT = { limit: 60, windowSeconds: 3600 }
export const AUTHENTICATED_LIMIT = { limit: 5000, windowSeconds: 3600 }

export interface RateLimitResult {
  allowed: boolean
  limit: number
  remaining: number
  /** Unix epoch seconds when the current window resets. */
  resetAt: number
}

const KV_PREFIX = 'rl:'

export async function checkRateLimit(
  kv: KVNamespace,
  bucket: string,
  limit: number,
  windowSeconds: number,
  now = Math.floor(Date.now() / 1000),
): Promise<RateLimitResult> {
  const windowStart = Math.floor(now / windowSeconds) * windowSeconds
  const resetAt = windowStart + windowSeconds
  const key = `${KV_PREFIX}${bucket}:${String(windowStart)}`

  const current = Number((await kv.get(key, 'text')) ?? '0')
  if (current >= limit) {
    return { allowed: false, limit, remaining: 0, resetAt }
  }
  await kv.put(key, String(current + 1), {
    // Keep the counter around a full extra window so clock skew between
    // isolates can't resurrect an expired key mid-window.
    expirationTtl: Math.max(windowSeconds * 2, 60),
  })
  return { allowed: true, limit, remaining: limit - current - 1, resetAt }
}

export function rateLimitHeaders(
  result: RateLimitResult,
): Record<string, string> {
  return {
    'X-RateLimit-Limit': String(result.limit),
    'X-RateLimit-Remaining': String(result.remaining),
    'X-RateLimit-Reset': String(result.resetAt),
  }
}

export function rateLimitedResponse(
  result: RateLimitResult,
  now = Math.floor(Date.now() / 1000),
): Response {
  return Response.json(
    {
      error: {
        code: 'rate_limited',
        message: `Rate limit exceeded (${String(result.limit)} requests/hour). Authenticate for higher limits: POST /v1/agents/register-key or the agent-auth protocol at /.well-known/agent-configuration.`,
      },
    },
    {
      status: 429,
      headers: {
        'Retry-After': String(Math.max(result.resetAt - now, 1)),
        ...rateLimitHeaders(result),
      },
    },
  )
}

function decodeJwtSub(token: string): string | null {
  const parts = token.split('.')
  if (parts.length !== 3 || !parts[1]) return null
  try {
    const payload = JSON.parse(
      atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')),
    ) as { sub?: unknown }
    return typeof payload.sub === 'string' ? payload.sub : null
  } catch {
    return null
  }
}

/**
 * Verify an agent JWT's signature + expiry against the agent's stored public
 * key WITHOUT consuming the replay-protected jti (full verification happens
 * at the route layer; doing it here would burn the token before the route
 * sees it). Returns true only when the JWT was signed by the agent named in
 * its `sub`.
 */
async function verifyAgentJwtSignature(
  db: Db,
  sub: string,
  token: string,
): Promise<boolean> {
  try {
    const row = await db.query.agent.findFirst({
      where: eq(agent.id, sub),
      columns: { publicKey: true, status: true },
    })
    if (!row?.publicKey || row.status !== 'active') return false
    const key = await importJWK(JSON.parse(row.publicKey) as JWK, 'EdDSA')
    await jwtVerify(token, key, { clockTolerance: 5 })
    return true
  } catch {
    return false
  }
}

/**
 * Resolve the rate-limit bucket for a request.
 *
 * - API keys (non-JWT bearer / X-Api-Key) are verified — invalid keys fall
 *   back to the anonymous IP bucket.
 * - Agent JWTs are signature-verified against the agent's stored key (but
 *   the jti is NOT consumed — replay protection stays with the route's
 *   auth). Forged or unverifiable JWTs fall back to the anonymous IP
 *   bucket, so unverified claims can never mint authenticated windows.
 */
export async function resolveRateBucket(
  auth: Auth,
  db: Db,
  request: Request,
): Promise<{ bucket: string; limit: number; windowSeconds: number }> {
  const header = request.headers.get('authorization')
  const bearer = header?.startsWith('Bearer ')
    ? header.slice('Bearer '.length)
    : null
  const credential = request.headers.get('x-api-key') ?? bearer

  if (credential) {
    if (credential.split('.').length === 3) {
      const sub = decodeJwtSub(credential)
      if (sub && (await verifyAgentJwtSignature(db, sub, credential))) {
        return { bucket: `agent:${sub}`, ...AUTHENTICATED_LIMIT }
      }
    } else {
      const verified = await auth.api.verifyApiKey({
        body: { key: credential },
      })
      if (verified.valid && verified.key) {
        return { bucket: `key:${verified.key.id}`, ...AUTHENTICATED_LIMIT }
      }
    }
  }

  const ip =
    request.headers.get('cf-connecting-ip') ??
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'
  return { bucket: `ip:${ip}`, ...ANONYMOUS_LIMIT }
}

/** Read the current window's usage without incrementing (for /v1/agents/me). */
export async function readRateUsage(
  kv: KVNamespace,
  bucket: string,
  limit: number,
  windowSeconds: number,
  now = Math.floor(Date.now() / 1000),
): Promise<{
  used: number
  remaining: number
  limit: number
  resetAt: number
}> {
  const windowStart = Math.floor(now / windowSeconds) * windowSeconds
  const used = Number(
    (await kv.get(`${KV_PREFIX}${bucket}:${String(windowStart)}`, 'text')) ??
      '0',
  )
  return {
    used,
    remaining: Math.max(limit - used, 0),
    limit,
    resetAt: windowStart + windowSeconds,
  }
}

/**
 * Enforce the rate limit for a /v1 request. Returns a 429 Response when the
 * window is exhausted, null when the request may proceed.
 */
export async function enforceRateLimit(
  auth: Auth,
  db: Db,
  kv: KVNamespace,
  request: Request,
  now = Math.floor(Date.now() / 1000),
): Promise<Response | null> {
  const { bucket, limit, windowSeconds } = await resolveRateBucket(
    auth,
    db,
    request,
  )
  const result = await checkRateLimit(kv, bucket, limit, windowSeconds, now)
  if (!result.allowed) return rateLimitedResponse(result, now)
  return null
}
