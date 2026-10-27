import { beforeAll, describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'

import { getDb } from '../db/index.ts'
import type { Db } from '../db/index.ts'
import { changes, providers } from '../db/schema.ts'
import { MODEL_ROW_SHAPE, recordRowShape } from './row-shape.ts'

const NOW = 1_781_150_000
let db: Db

beforeAll(async () => {
  db = getDb(env)
  await db.insert(providers).values(
    Array.from({ length: 12 }, (_, i) => ({
      id: `shape-prov-${String(i)}`,
      displayName: `Shape ${String(i)}`,
      specSourceUrl: 'https://example.com/spec.json',
    })),
  )
})

async function shapeRows() {
  return db
    .select()
    .from(changes)
    .where(eq(changes.type, 'catalog.shape_changed'))
}

describe('recordRowShape', () => {
  it('announces a shape once per provider, then only when the version moves', async () => {
    const providerCount = (await db.select().from(providers)).length
    expect(await recordRowShape(db, NOW)).toBe(providerCount)
    expect(await recordRowShape(db, NOW + 900)).toBe(0)

    const first = await shapeRows()
    expect(first).toHaveLength(providerCount)
    expect(first[0]).toMatchObject({
      subjectId: 'model-row',
      summary: `Model row shape v${String(MODEL_ROW_SHAPE.version)}`,
      payload: {
        version: MODEL_ROW_SHAPE.version,
        contentHash: MODEL_ROW_SHAPE.hash,
        previousHash: null,
      },
    })

    // A provider added later gets the current shape on its first poll.
    await db.insert(providers).values({
      id: 'shape-prov-late',
      displayName: 'Shape late',
      specSourceUrl: 'https://example.com/spec.json',
    })
    expect(await recordRowShape(db, NOW + 1200)).toBe(1)
    expect(await recordRowShape(db, NOW + 1500)).toBe(0)

    // The emitter respelling the same shape moves the hash, not the version.
    const respelled = { ...MODEL_ROW_SHAPE, hash: 'a'.repeat(64) }
    expect(await recordRowShape(db, NOW + 1600, respelled)).toBe(0)

    const next = { version: 99, hash: 'b'.repeat(64), notes: 'next' }
    expect(await recordRowShape(db, NOW + 1800, next)).toBe(providerCount + 1)
    const bumped = (await shapeRows()).filter(
      (row) => row.createdAt === NOW + 1800,
    )
    expect(bumped[0]?.payload).toEqual({
      version: 99,
      contentHash: next.hash,
      previousHash: MODEL_ROW_SHAPE.hash,
      notes: 'next',
    })
  })
})
