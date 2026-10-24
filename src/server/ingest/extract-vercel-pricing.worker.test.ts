import { requestUrl } from '#/lib/text.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'

import { getDb } from '../../db/index.ts'
import { changes, models, providers } from '../../db/schema.ts'
import { modelDbId } from './poll-models.ts'
import { extractVercelPricing } from './extract-vercel-pricing.ts'
import { VERCEL_MODELS_URL } from '../providers/adapters/vercel.ts'

const RAW = 'alibaba/qwen-3-235b'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function endpoints(second: Record<string, unknown>) {
  return {
    data: {
      endpoints: [
        {
          provider_name: 'deepinfra',
          status: 0,
          pricing: { prompt: '0.00000009', completion: '0.00000055' },
        },
        second,
      ],
    },
  }
}

describe('extractVercelPricing', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('writes a range, keeps it when the fetch fails, and clears it when a route has no price', async () => {
    const db = getDb(env)
    await db.insert(providers).values({
      id: 'vercel',
      displayName: 'Vercel',
      specSourceUrl: 'https://ai-gateway.vercel.sh/v1/models',
    })
    const id = modelDbId('vercel', RAW)
    const now = 1_781_150_000
    await db.insert(models).values({
      id,
      providerId: 'vercel',
      rawId: RAW,
      activity: 'chat',
      firstSeenAt: now,
      lastSeenAt: now,
    })
    const listing = {
      data: [{ id: RAW, pricing: { varies_by_provider: true } }],
    }
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = requestUrl(input)
      if (url === VERCEL_MODELS_URL) return json(listing)
      if (url.endsWith('/endpoints')) {
        return json(
          endpoints({
            provider_name: 'vertex',
            status: 1,
            pricing: { prompt: '0.00000022', completion: '0.00000088' },
          }),
        )
      }
      return json({ error: 'no' }, 404)
    })
    const first = await extractVercelPricing({
      db,
      kv: env.SCHEMA_CACHE,
      secrets: {},
    })
    expect(first).toMatchObject({
      candidates: 1,
      fetched: 1,
      ranged: 0,
      refused: 1,
    })
    // One available route is not a range.
    expect(
      (await db.select().from(models).where(eq(models.id, id)))[0]
        ?.pricingRange,
    ).toBeNull()

    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = requestUrl(input)
      if (url === VERCEL_MODELS_URL) return json(listing)
      if (url.endsWith('/endpoints')) {
        return json(
          endpoints({
            provider_name: 'vertex',
            status: 0,
            pricing: { prompt: '0.00000022', completion: '0.00000088' },
          }),
        )
      }
      return json({}, 500)
    })
    const ranged = await extractVercelPricing({
      db,
      kv: env.SCHEMA_CACHE,
      secrets: {},
    })
    expect(ranged).toMatchObject({ fetched: 1, ranged: 1, fetchFailed: 0 })
    const stored = (await db.select().from(models).where(eq(models.id, id)))[0]
    expect(stored?.pricingRange?.routes.map((route) => route.provider)).toEqual(
      ['deepinfra', 'vertex'],
    )
    expect(stored?.pricingRange?.routes[0]?.card).toBeTruthy()
    expect(stored?.factSources).toMatchObject({
      pricingRange: { path: 'data.endpoints[status=0].pricing' },
    })
    const updated = await db
      .select()
      .from(changes)
      .where(eq(changes.subjectId, id))
    expect(updated.length).toBeGreaterThan(0)

    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = requestUrl(input)
      if (url === VERCEL_MODELS_URL) return json(listing)
      return json({ error: 'down' }, 503)
    })
    const failed = await extractVercelPricing({
      db,
      kv: env.SCHEMA_CACHE,
      secrets: {},
    })
    expect(failed).toMatchObject({ fetchFailed: 1, fetched: 0 })
    const kept = (await db.select().from(models).where(eq(models.id, id)))[0]
    expect(kept?.pricingRange?.routes).toHaveLength(2)

    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = requestUrl(input)
      if (url === VERCEL_MODELS_URL) return json(listing)
      if (url.endsWith('/endpoints')) {
        return json(
          endpoints({
            provider_name: 'vertex',
            status: 0,
            pricing: { prompt: '0', completion: '0' },
          }),
        )
      }
      return json({}, 500)
    })
    const refused = await extractVercelPricing({
      db,
      kv: env.SCHEMA_CACHE,
      secrets: {},
    })
    expect(refused).toMatchObject({ fetched: 1, refused: 1, ranged: 0 })
    expect(
      (await db.select().from(models).where(eq(models.id, id)))[0]
        ?.pricingRange,
    ).toBeNull()
  })
})
