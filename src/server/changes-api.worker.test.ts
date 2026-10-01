import { beforeAll, describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'

import { getDb } from '../db/index.ts'
import type { Db } from '../db/index.ts'
import { changes, providers } from '../db/schema.ts'
import {
  countChangesByType,
  decodeCursor,
  encodeCursor,
  listChanges,
} from './changes-api.ts'

const NOW = 1_781_150_000
let db: Db

beforeAll(async () => {
  db = getDb(env)
  await db.insert(providers).values({
    id: 'chg-prov',
    displayName: 'Changes Prov',
    specSourceUrl: 'https://example.com/spec.json',
  })
  // Five changes: two share a createdAt to exercise the (createdAt, id)
  // keyset tie-break.
  await db.insert(changes).values([
    {
      id: 'chg-1',
      type: 'model.added',
      providerId: 'chg-prov',
      subjectId: 'm1',
      summary: 'one',
      createdAt: NOW + 1,
    },
    {
      id: 'chg-2',
      type: 'model.added',
      providerId: 'chg-prov',
      subjectId: 'm2',
      summary: 'two',
      createdAt: NOW + 2,
    },
    {
      id: 'chg-3a',
      type: 'schema.updated',
      providerId: 'chg-prov',
      subjectId: 'e1',
      summary: 'three-a',
      createdAt: NOW + 3,
    },
    {
      id: 'chg-3b',
      type: 'schema.updated',
      providerId: 'chg-prov',
      subjectId: 'e2',
      summary: 'three-b',
      createdAt: NOW + 3,
    },
    {
      id: 'chg-4',
      type: 'model.removed',
      providerId: 'chg-prov',
      subjectId: 'm1',
      summary: 'four',
      createdAt: NOW + 4,
    },
  ])
})

describe('listChanges pagination', () => {
  it('pages through all rows without overlap, newest first', async () => {
    const seen: Array<string> = []
    let cursor: string | undefined
    let pages = 0
    do {
      const outcome = await listChanges(db, {
        provider: 'chg-prov',
        limit: 2,
        cursor,
      })
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) break
      seen.push(...outcome.result.changes.map((c) => c.id))
      if (outcome.result.nextCursor) {
        expect(outcome.result._links.next?.href).toContain('cursor=')
      }
      cursor = outcome.result.nextCursor ?? undefined
      pages++
    } while (cursor && pages < 10)

    expect(pages).toBe(3) // 2 + 2 + 1
    expect(seen).toEqual(['chg-4', 'chg-3b', 'chg-3a', 'chg-2', 'chg-1'])
    expect(new Set(seen).size).toBe(seen.length)
  })

  it('filters by since and type', async () => {
    const since = await listChanges(db, {
      provider: 'chg-prov',
      since: NOW + 3,
    })
    expect(since.ok && since.result.changes.map((c) => c.id)).toEqual([
      'chg-4',
      'chg-3b',
      'chg-3a',
    ])

    const typed = await listChanges(db, {
      provider: 'chg-prov',
      type: 'model.added',
    })
    expect(typed.ok && typed.result.changes.map((c) => c.id)).toEqual([
      'chg-2',
      'chg-1',
    ])
  })

  it('rejects garbage cursors with a 400', async () => {
    const outcome = await listChanges(db, { cursor: 'not-base64!!' })
    expect(outcome).toMatchObject({
      ok: false,
      status: 400,
      code: 'invalid_cursor',
    })
  })

  it('round-trips cursors, including ids containing colons', () => {
    const cursor = { createdAt: NOW, id: 'a:b:c' }
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor)
    expect(decodeCursor('AAAA')).toBeNull()
  })
})

describe('countChangesByType', () => {
  it('tallies changes per type from `since` onward', async () => {
    expect(await countChangesByType(db, NOW + 2)).toEqual({
      'model.added': 1,
      'schema.updated': 2,
      'model.removed': 1,
    })
  })
})
