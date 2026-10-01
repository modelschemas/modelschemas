/**
 * Changes feed (PLAN.md task 4.5) — the polling-friendly alternative to
 * webhooks. Cursor-paginated, newest first; the cursor is an opaque
 * (createdAt, id) keyset token, so pages stay stable while new changes land.
 */
import { and, count, desc, eq, gte, lt, or } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'

import type { Db } from '#/db/index.ts'
import { halGet } from '#/server/hal.ts'
import type { HalLink } from '#/server/hal.ts'
import { changes } from '#/db/schema.ts'
import type { ChangeType } from '#/db/schema.ts'

export interface ChangesQuery {
  since?: number
  provider?: string
  type?: ChangeType
  cursor?: string
  limit?: number
}

export const MAX_CHANGES_LIMIT = 200
const DEFAULT_LIMIT = 50

interface Cursor {
  createdAt: number
  id: string
}

export function encodeCursor(cursor: Cursor): string {
  return btoa(`${String(cursor.createdAt)}:${cursor.id}`)
}

export function decodeCursor(token: string): Cursor | null {
  try {
    const [createdAt, ...idParts] = atob(token).split(':')
    const time = Number(createdAt)
    const id = idParts.join(':')
    if (!Number.isInteger(time) || id === '') return null
    return { createdAt: time, id }
  } catch {
    return null
  }
}

export type ListChangesOutcome =
  | {
      ok: true
      result: {
        count: number
        changes: Array<typeof changes.$inferSelect>
        nextCursor: string | null
        _links: { self: HalLink; next?: HalLink }
      }
    }
  | { ok: false; status: number; code: string; message: string }

export async function listChanges(
  db: Db,
  query: ChangesQuery,
): Promise<ListChangesOutcome> {
  const limit = Math.min(
    Math.max(query.limit ?? DEFAULT_LIMIT, 1),
    MAX_CHANGES_LIMIT,
  )

  const conditions: Array<SQL> = []
  if (query.since !== undefined) {
    conditions.push(gte(changes.createdAt, query.since))
  }
  if (query.provider) conditions.push(eq(changes.providerId, query.provider))
  if (query.type) conditions.push(eq(changes.type, query.type))

  if (query.cursor !== undefined) {
    const cursor = decodeCursor(query.cursor)
    if (!cursor) {
      return {
        ok: false,
        status: 400,
        code: 'invalid_cursor',
        message:
          'Invalid cursor. Use the nextCursor value from a previous response.',
      }
    }
    const keyset = or(
      lt(changes.createdAt, cursor.createdAt),
      and(eq(changes.createdAt, cursor.createdAt), lt(changes.id, cursor.id)),
    )
    if (keyset) conditions.push(keyset)
  }

  // Fetch one extra row to know whether another page exists.
  const rows = await db
    .select()
    .from(changes)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(changes.createdAt), desc(changes.id))
    .limit(limit + 1)

  const page = rows.slice(0, limit)
  const last = page[page.length - 1]
  const nextCursor =
    rows.length > limit && last
      ? encodeCursor({ createdAt: last.createdAt, id: last.id })
      : null

  const params = new URLSearchParams()
  if (query.since !== undefined) params.set('since', String(query.since))
  if (query.provider) params.set('provider', query.provider)
  if (query.type) params.set('type', query.type)
  const baseParams = params.toString()
  const self = `/v1/changes${baseParams ? `?${baseParams}` : ''}`

  return {
    ok: true,
    result: {
      count: page.length,
      changes: page,
      nextCursor,
      _links: {
        self: halGet(self),
        ...(nextCursor
          ? {
              next: halGet(
                `/v1/changes?${baseParams ? `${baseParams}&` : ''}cursor=${encodeURIComponent(nextCursor)}`,
              ),
            }
          : {}),
      },
    },
  }
}

/** Change counts per type since `since` — the landing page's drift tally. */
export async function countChangesByType(
  db: Db,
  since: number,
): Promise<Partial<Record<ChangeType, number>>> {
  const rows = await db
    .select({ type: changes.type, n: count() })
    .from(changes)
    .where(gte(changes.createdAt, since))
    .groupBy(changes.type)
  return Object.fromEntries(rows.map((r) => [r.type, r.n]))
}
