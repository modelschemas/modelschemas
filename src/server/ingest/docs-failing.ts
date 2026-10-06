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
 *
 * A refused mass price clear (`refusesPriceClears`) keeps the same kind of
 * row, `price-clears-refused:<providerId>`, holding a `PriceClearsRefused`.
 * `GET /v1/status` serves both (`readIngestRecords`).
 */
import { eq, like, or } from 'drizzle-orm'

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

export interface PriceClearsRefused {
  /** Epoch seconds of the first poll in this unbroken run of refusals. */
  since: number
  /** Consecutive polls that refused, this one included. */
  polls: number
  lastAt: number
  /** Stored prices the latest poll asked to clear; none was cleared. */
  refused: number
  /** Listed rows holding a stored price at that poll. */
  priced: number
}

/** Both records of one provider, as `GET /v1/status` serves them. */
export interface IngestRecords {
  docsFailing?: DocsFailing
  priceClearsRefused?: PriceClearsRefused
}

const DOCS = 'docs-failing:'
const CLEARS = 'price-clears-refused:'

/** An upstream error can quote a whole HTML page. */
const ERROR_MAX = 500

function key(providerId: string): string {
  return `${DOCS}${providerId}`
}

/**
 * A row that is not ours to read counts as no record: the next failing
 * poll overwrites it, the next healthy one deletes it.
 */
function parse<T extends { since: number; polls: number }>(
  text: string | null | undefined,
  list?: 'sources',
): T | null {
  if (!text) return null
  try {
    const value = JSON.parse(text) as Partial<Record<string, unknown>> | null
    if (typeof value?.since !== 'number' || typeof value.polls !== 'number') {
      return null
    }
    if (list && !Array.isArray(value[list])) return null
    return value as T
  } catch {
    return null
  }
}

/** Every provider's records in one statement, keyed by provider id. */
export async function readIngestRecords(
  db: Db,
): Promise<Map<string, IngestRecords>> {
  const rows = await db
    .select({ key: cacheMeta.key, lastError: cacheMeta.lastError })
    .from(cacheMeta)
    .where(
      or(like(cacheMeta.key, `${DOCS}%`), like(cacheMeta.key, `${CLEARS}%`)),
    )
  const byProvider = new Map<string, IngestRecords>()
  const entry = (providerId: string) => {
    const records = byProvider.get(providerId) ?? {}
    byProvider.set(providerId, records)
    return records
  }
  for (const row of rows) {
    if (row.key.startsWith(DOCS)) {
      const record = parse<DocsFailing>(row.lastError, 'sources')
      if (record) entry(row.key.slice(DOCS.length)).docsFailing = record
    } else {
      const record = parse<PriceClearsRefused>(row.lastError)
      if (record) {
        entry(row.key.slice(CLEARS.length)).priceClearsRefused = record
      }
    }
  }
  return byProvider
}

export async function readDocsFailing(
  db: Db,
  providerId: string,
): Promise<DocsFailing | null> {
  const row = await db.query.cacheMeta.findFirst({
    where: eq(cacheMeta.key, key(providerId)),
  })
  return parse<DocsFailing>(row?.lastError, 'sources')
}

/**
 * Write or extend the provider's refused-clears record, or delete it when
 * this poll refused nothing. The record describes the poll; it must never
 * be what fails it, so a failed write is logged and swallowed.
 */
export async function recordPriceClearsRefused(
  db: Db,
  providerId: string,
  refused: { clears: number; priced: number } | null,
  now: number,
): Promise<void> {
  const rowKey = `${CLEARS}${providerId}`
  try {
    if (!refused) {
      await db.delete(cacheMeta).where(eq(cacheMeta.key, rowKey))
      return
    }
    const row = await db.query.cacheMeta.findFirst({
      where: eq(cacheMeta.key, rowKey),
    })
    const prior = parse<PriceClearsRefused>(row?.lastError)
    const record: PriceClearsRefused = {
      since: prior?.since ?? now,
      polls: (prior?.polls ?? 0) + 1,
      lastAt: now,
      refused: refused.clears,
      priced: refused.priced,
    }
    const lastError = JSON.stringify(record)
    await db
      .insert(cacheMeta)
      .values({
        key: rowKey,
        fetchedAt: record.since,
        staleTime: 0,
        lastError,
      })
      .onConflictDoUpdate({
        target: cacheMeta.key,
        set: { fetchedAt: record.since, lastError },
      })
  } catch (error) {
    console.error(
      JSON.stringify({
        job: 'models-poll',
        providerId,
        error: `price-clears-refused record not written: ${error instanceof Error ? error.message : String(error)}`,
      }),
    )
  }
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
    error: (docs.first[0]?.error ?? '').slice(0, ERROR_MAX),
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
    .onConflictDoUpdate({
      target: cacheMeta.key,
      set: { fetchedAt: record.since, lastError },
    })
  return record
}
