/**
 * Server-side stale-while-revalidate cache (PLAN.md task 3.1) — the
 * "server-side react query". Values live in KV; freshness metadata lives in
 * the `cache_meta` D1 table. Reads always serve immediately; stale reads
 * kick a background revalidation through `waitUntil`, deduped across
 * isolates by the `cache_meta.refreshing` flag.
 */
import { eq } from 'drizzle-orm'

import type { Db } from '#/db/index.ts'
import { cacheMeta } from '#/db/schema.ts'
import { getJson, putJson } from '#/server/kv.ts'

export interface SwrDeps {
  db: Db
  kv: KVNamespace
  /** `ctx.waitUntil` — keeps background revalidation alive past the response. */
  waitUntil: (promise: Promise<unknown>) => void
  /** Injectable clock (unix epoch seconds) for deterministic tests. */
  now?: () => number
}

export interface SwrOptions {
  /** Seconds a cached value is considered fresh. */
  staleTime: number
  /** Optional KV expirationTtl (seconds) — the hard eviction backstop. */
  hardTtl?: number
}

export interface SwrResult<T> {
  value: T
  fetchedAt: number
  staleAt: number
  /** True when this read kicked off a background revalidation. */
  revalidating: boolean
}

const KV_PREFIX = 'swr:'

async function persist<T>(
  deps: SwrDeps,
  key: string,
  value: T,
  staleTime: number,
  hardTtl: number | undefined,
  fetchedAt: number,
): Promise<void> {
  await putJson(
    deps.kv,
    KV_PREFIX + key,
    value,
    hardTtl !== undefined ? { expirationTtl: hardTtl } : undefined,
  )
  await deps.db
    .insert(cacheMeta)
    .values({ key, fetchedAt, staleTime, refreshing: false, lastError: null })
    .onConflictDoUpdate({
      target: cacheMeta.key,
      set: { fetchedAt, staleTime, refreshing: false, lastError: null },
    })
}

async function revalidate<T>(
  deps: SwrDeps,
  key: string,
  fetcher: () => Promise<T>,
  options: SwrOptions,
  now: number,
): Promise<void> {
  try {
    const value = await fetcher()
    await persist(deps, key, value, options.staleTime, options.hardTtl, now)
  } catch (error) {
    await deps.db
      .update(cacheMeta)
      .set({
        refreshing: false,
        lastError: error instanceof Error ? error.message : String(error),
      })
      .where(eq(cacheMeta.key, key))
  }
}

/**
 * KV hit + fresh → return. KV hit + stale → return immediately AND
 * revalidate in the background (guarded by the `refreshing` flag; a stuck
 * flag older than 2× staleTime is ignored). Miss → fetch inline + persist.
 */
export async function swr<T>(
  deps: SwrDeps,
  key: string,
  fetcher: () => Promise<T>,
  options: SwrOptions,
): Promise<SwrResult<T>> {
  const now = deps.now?.() ?? Math.floor(Date.now() / 1000)

  const [cached, meta] = await Promise.all([
    getJson<T>(deps.kv, KV_PREFIX + key),
    deps.db.query.cacheMeta.findFirst({ where: eq(cacheMeta.key, key) }),
  ])

  if (cached !== null && meta) {
    const staleAt = meta.fetchedAt + meta.staleTime
    if (now < staleAt) {
      return {
        value: cached,
        fetchedAt: meta.fetchedAt,
        staleAt,
        revalidating: false,
      }
    }

    // Stale: serve immediately, revalidate in the background unless another
    // isolate already is. A flag that has been set for over 2× staleTime is
    // treated as stuck (crashed revalidation) and ignored.
    const stuck = now > meta.fetchedAt + 2 * meta.staleTime
    let revalidating = false
    if (!meta.refreshing || stuck) {
      await deps.db
        .update(cacheMeta)
        .set({ refreshing: true })
        .where(eq(cacheMeta.key, key))
      deps.waitUntil(revalidate(deps, key, fetcher, options, now))
      revalidating = true
    }
    return { value: cached, fetchedAt: meta.fetchedAt, staleAt, revalidating }
  }

  // Miss (no blob or no metadata): fetch inline.
  const value = await fetcher()
  await persist(deps, key, value, options.staleTime, options.hardTtl, now)
  return {
    value,
    fetchedAt: now,
    staleAt: now + options.staleTime,
    revalidating: false,
  }
}
