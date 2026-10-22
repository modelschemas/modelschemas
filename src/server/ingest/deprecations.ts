/**
 * Write a provider's deprecations page onto its rows (issue #410).
 *
 * `models.deprecation` holds the page's entry as stated. A row with one is
 * deprecated: `deprecatedAt` is the stated date, or when we first saw it
 * deprecated when the page gives none. An id the page names that has no
 * row gets a retired one, so a model shut down before we polled it still
 * answers "retired, use X". Every change to a row's entry is one
 * `model.deprecated` change.
 */
import { eq } from 'drizzle-orm'
import type { Db } from '#/db/index.ts'
import { changes, models } from '#/db/schema.ts'
import type { ModelDeprecation } from '#/server/providers/types.ts'

/** Row id → page entry. */
export type DeprecationIndex = ReadonlyMap<string, ModelDeprecation>

/**
 * The entry a row carries this poll. No index (no page, or it failed)
 * keeps what is stored.
 */
export function rowDeprecation(
  index: DeprecationIndex | null,
  id: string,
  stored: unknown,
): ModelDeprecation | null {
  if (index) return index.get(id) ?? null
  return (stored as ModelDeprecation | null | undefined) ?? null
}

function sameDeprecation(a: unknown, b: ModelDeprecation | null): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b)
}

function day(epoch: number | null): string | null {
  return epoch === null
    ? null
    : new Date(epoch * 1000).toISOString().slice(0, 10)
}

function summary(rawId: string, entry: ModelDeprecation | null): string {
  if (!entry) return `Model ${rawId} no longer on the deprecations page`
  const parts = [`Model ${rawId} deprecated`]
  const retires = day(entry.retiresAt)
  if (retires) parts.push(`retires ${retires}`)
  if (entry.replacedBy) parts.push(`use ${entry.replacedBy.join(' or ')}`)
  return parts.join('; ')
}

/** Apply the page to every row of the provider. */
export async function applyDeprecations(
  db: Db,
  providerId: string,
  index: DeprecationIndex,
  now: number,
): Promise<void> {
  const rows = await db
    .select({
      id: models.id,
      rawId: models.rawId,
      deprecatedAt: models.deprecatedAt,
      deprecation: models.deprecation,
    })
    .from(models)
    .where(eq(models.providerId, providerId))
  const stored = new Set(rows.map((row) => row.id))
  const writes = []
  for (const row of rows) {
    const entry = index.get(row.id) ?? null
    if (sameDeprecation(row.deprecation, entry)) continue
    writes.push(
      db
        .update(models)
        .set({
          deprecation: entry,
          // A withdrawn entry leaves deprecatedAt to the listing: the poll
          // already cleared it on a listed row, an unlisted one stays gone.
          ...(entry
            ? { deprecatedAt: entry.deprecatedAt ?? row.deprecatedAt ?? now }
            : {}),
        })
        .where(eq(models.id, row.id)),
      db.insert(changes).values({
        id: crypto.randomUUID(),
        type: 'model.deprecated',
        providerId,
        subjectId: row.id,
        summary: summary(row.rawId, entry),
        payload: { before: row.deprecation ?? null, after: entry },
        createdAt: now,
      }),
    )
  }
  for (const [id, entry] of index) {
    if (stored.has(id)) continue
    writes.push(
      db.insert(models).values({
        id,
        providerId,
        rawId: entry.rawId,
        firstSeenAt: now,
        lastSeenAt: now,
        deprecatedAt: entry.deprecatedAt ?? now,
        deprecation: entry,
      }),
      db.insert(changes).values({
        id: crypto.randomUUID(),
        type: 'model.deprecated',
        providerId,
        subjectId: id,
        summary: summary(entry.rawId, entry),
        payload: { before: null, after: entry },
        createdAt: now,
      }),
    )
  }
  // Batched: a first poll writes a provider's whole deprecation history.
  for (let i = 0; i < writes.length; i += 40) {
    const [first, ...rest] = writes.slice(i, i + 40)
    if (first) await db.batch([first, ...rest])
  }
}
