import { beforeAll, describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'

import { getDb } from '../db/index.ts'
import type { Db } from '../db/index.ts'
import { changes, providers } from '../db/schema.ts'
import { parseWaitSeconds, waitForNewChange } from './wait.ts'

let db: Db

beforeAll(async () => {
  db = getDb(env)
  await db.insert(providers).values({
    id: 'wait-prov',
    displayName: 'Wait Prov',
    specSourceUrl: 'https://example.com/spec.json',
  })
  await db.insert(changes).values({
    id: 'wait-baseline',
    type: 'model.added',
    providerId: 'wait-prov',
    subjectId: 'm0',
    summary: 'baseline',
    createdAt: 1_000,
  })
})

describe('?wait= long-poll (task 11.3)', () => {
  it('parses wait seconds, accepts the 60s form, caps at 60', () => {
    const url = (q: string) => new URL(`https://x.test/v1/changes?${q}`)
    expect(parseWaitSeconds(url('wait=5'))).toBe(5)
    expect(parseWaitSeconds(url('wait=30s'))).toBe(30)
    expect(parseWaitSeconds(url('wait=999'))).toBe(60)
    expect(parseWaitSeconds(url('wait=abc'))).toBe(0)
    expect(parseWaitSeconds(url(''))).toBe(0)
  })

  it('returns early when a change lands mid-wait', async () => {
    const started = Date.now()
    const insertion = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 300))
      await db.insert(changes).values({
        id: 'wait-mid',
        type: 'model.added',
        providerId: 'wait-prov',
        subjectId: 'm1',
        summary: 'lands mid-wait',
        createdAt: 2_000,
      })
    })()
    // wait=2 with a 250ms poll: the change at ~300ms must end the hold
    // well before the 2s window expires.
    await waitForNewChange(db, 2, 250)
    await insertion
    const elapsed = Date.now() - started
    expect(elapsed).toBeLessThan(1_500)
    expect(elapsed).toBeGreaterThanOrEqual(300)
  })

  it('holds for ~the full window when nothing changes', async () => {
    const started = Date.now()
    await waitForNewChange(db, 1, 250)
    const elapsed = Date.now() - started
    expect(elapsed).toBeGreaterThanOrEqual(950)
    expect(elapsed).toBeLessThan(2_000)
  })
})
