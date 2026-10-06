/**
 * The durable trace of a docs source that keeps failing. A docs failure no
 * longer fails the poll, so `lastPolledAt` keeps moving and each poll's log
 * line says nothing of the ones before it. One `cache_meta` row per
 * provider, `docs-failing:<providerId>`, records when the failures began
 * and how many polls they have lasted. It is deleted by the first poll
 * whose docs all load. Read it with:
 *
 *   select key, fetched_at, last_error from cache_meta
 *   where key like 'docs-failing:%'
 *
 * `fetched_at` is the first failing poll; `last_error` is a `DocsFailing`.
 */
import { eq } from 'drizzle-orm'

import type { Db } from '#/db/index.ts'
import { cacheMeta } from '#/db/schema.ts'
import type { DocsFailures } from '#/server/providers/types.ts'

export interface DocsFailing {
  /** Epoch seconds of the first poll in this unbroken run of failures. */
  since: number
  /** Consecutive polls with a docs failure, this one included. */
  polls: number
  lastAt: number
  failed: number
  skipped: number
  /** The first few failing documents of the latest poll. */
  sources: Array<string>
  /** The latest poll's first error. */
  error: string
}

function key(providerId: string): string {
  return `docs-failing:${providerId}`
}

export async function readDocsFailing(
  db: Db,
  providerId: string,
): Promise<DocsFailing | null> {
  const row = await db.query.cacheMeta.findFirst({
    where: eq(cacheMeta.key, key(providerId)),
  })
  if (!row?.lastError) return null
  return JSON.parse(row.lastError) as DocsFailing
}

/** Write, extend, or (when nothing failed) delete the provider's record. */
export async function recordDocsFailing(
  db: Db,
  providerId: string,
  docs: DocsFailures,
  now: number,
): Promise<DocsFailing | null> {
  if (docs.failed + docs.skipped === 0) {
    await db.delete(cacheMeta).where(eq(cacheMeta.key, key(providerId)))
    return null
  }
  const prior = await readDocsFailing(db, providerId)
  const record: DocsFailing = {
    since: prior?.since ?? now,
    polls: (prior?.polls ?? 0) + 1,
    lastAt: now,
    failed: docs.failed,
    skipped: docs.skipped,
    sources: docs.first.map((failure) => failure.source),
    error: docs.first[0]?.error ?? '',
  }
  const lastError = JSON.stringify(record)
  await db
    .insert(cacheMeta)
    .values({
      key: key(providerId),
      fetchedAt: record.since,
      staleTime: 0,
      lastError,
    })
    .onConflictDoUpdate({ target: cacheMeta.key, set: { lastError } })
  return record
}
