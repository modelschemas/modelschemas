import { bodyText, requestUrl } from '#/lib/text.ts'
import { beforeAll, describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'

import { getDb } from '../db/index.ts'
import type { Db } from '../db/index.ts'
import {
  changes,
  providers,
  subscriptions,
  user,
  webhookDeliveries,
} from '../db/schema.ts'
import {
  MAX_ATTEMPTS,
  deliverDue,
  enqueueNewChanges,
  runWebhookTick,
  signPayload,
} from './webhooks.ts'

const NOW = 1_781_150_000
const SECRET = 'whsec_test_secret'
let db: Db

/** Local receiver: a fetcher that records every request it gets. */
function receiver(status = 200) {
  const received: Array<{
    url: string
    body: string
    signature: string | null
  }> = []
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    received.push({
      url: requestUrl(input),
      body: bodyText(init?.body),
      signature:
        new Headers(init?.headers).get('x-modelschemas-signature') ?? null,
    })
    return new Response('ok', { status })
  }) as typeof globalThis.fetch
  return { received, fetcher }
}

let subSeq = 0
async function makeSubscription(
  events: Array<string>,
  providerFilter: string | null = null,
): Promise<string> {
  const id = `wh-sub-${String(subSeq++)}`
  await db.insert(subscriptions).values({
    id,
    agentId: 'wh-owner',
    url: `https://receiver.example.com/${id}`,
    secret: SECRET,
    events,
    providerFilter,
    active: true,
    createdAt: NOW,
  })
  return id
}

let changeSeq = 0
async function makeChange(
  type: 'model.added' | 'schema.updated',
  createdAt: number,
  providerId = 'wh-prov',
): Promise<string> {
  const id = `wh-change-${String(changeSeq++)}`
  await db.insert(changes).values({
    id,
    type,
    providerId,
    subjectId: 'subject',
    summary: `${type} happened`,
    createdAt,
  })
  return id
}

beforeAll(async () => {
  db = getDb(env)
  await db.insert(user).values({
    id: 'wh-owner',
    name: 'Webhook Owner',
    email: 'wh-owner@example.com',
    createdAt: new Date(NOW * 1000),
    updatedAt: new Date(NOW * 1000),
  })
  await db.insert(providers).values([
    {
      id: 'wh-prov',
      displayName: 'WH Prov',
      specSourceUrl: 'https://example.com/spec.json',
    },
    {
      id: 'wh-other',
      displayName: 'WH Other',
      specSourceUrl: 'https://example.com/spec.json',
    },
  ])
})

describe('webhook fan-out + signed delivery', () => {
  it('enqueues matching changes and delivers a verifiable signed payload', async () => {
    const subId = await makeSubscription(['model.added'])
    await makeChange('model.added', NOW + 1)
    await makeChange('schema.updated', NOW + 2) // not subscribed → no delivery

    const enqueued = await enqueueNewChanges(db, NOW + 10)
    expect(enqueued).toBe(1)

    const { received, fetcher } = receiver()
    const outcomes = await deliverDue(db, { fetcher, now: NOW + 10 })
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]).toMatchObject({ status: 'ok', responseCode: 200 })

    expect(received).toHaveLength(1)
    const hit = received[0]
    expect(hit?.url).toContain(subId)
    const parsed = JSON.parse(hit?.body ?? '{}') as {
      event: string
      change: { provider: string; summary: string }
      _links: Record<string, string>
    }
    expect(parsed.event).toBe('model.added')
    expect(parsed.change.provider).toBe('wh-prov')
    expect(parsed._links.changes).toContain('/v1/changes?since=')
    // The receiver can verify the signature by recomputing the HMAC.
    expect(hit?.signature).toBe(await signPayload(SECRET, hit?.body ?? ''))

    // Checkpoint advanced: re-running enqueues nothing.
    expect(await enqueueNewChanges(db, NOW + 20)).toBe(0)
  })

  it('respects provider filters', async () => {
    await makeSubscription(['model.added'], 'wh-other')
    await makeChange('model.added', NOW + 30, 'wh-prov')
    const enqueuedForOtherProvider = await enqueueNewChanges(db, NOW + 31)
    // The wh-other-filtered sub must not receive a wh-prov change; the
    // unfiltered sub from the previous test does.
    const pending = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.status, 'pending'))
    expect(enqueuedForOtherProvider).toBe(1)
    expect(pending).toHaveLength(1)
  })

  it('backs off exponentially and auto-pauses after MAX_ATTEMPTS', async () => {
    // Drain anything pending from prior tests first.
    await deliverDue(db, { fetcher: receiver(200).fetcher, now: NOW + 40 })

    const subId = await makeSubscription(['schema.updated'])
    await makeChange('schema.updated', NOW + 50)
    expect(await enqueueNewChanges(db, NOW + 51)).toBe(1)

    const failing = receiver(500)
    let clock = NOW + 60
    // First failure: attempt 1, nextAttemptAt = clock + 120.
    const first = await deliverDue(db, { fetcher: failing.fetcher, now: clock })
    expect(first[0]).toMatchObject({ status: 'pending', responseCode: 500 })
    let row = await db.query.webhookDeliveries.findFirst({
      where: eq(webhookDeliveries.subscriptionId, subId),
    })
    expect(row?.attempt).toBe(1)
    expect(row?.nextAttemptAt).toBe(clock + 120)

    // Not due yet → nothing happens.
    expect(
      await deliverDue(db, { fetcher: failing.fetcher, now: clock + 60 }),
    ).toHaveLength(0)

    // Fail through the remaining attempts.
    for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt++) {
      row = await db.query.webhookDeliveries.findFirst({
        where: eq(webhookDeliveries.subscriptionId, subId),
      })
      clock = (row?.nextAttemptAt ?? clock) + 1
      await deliverDue(db, { fetcher: failing.fetcher, now: clock })
    }

    row = await db.query.webhookDeliveries.findFirst({
      where: eq(webhookDeliveries.subscriptionId, subId),
    })
    expect(row?.status).toBe('failed')
    expect(row?.attempt).toBe(MAX_ATTEMPTS)

    const pausedSub = await db.query.subscriptions.findFirst({
      where: eq(subscriptions.id, subId),
    })
    expect(pausedSub?.active).toBe(false)
  })

  it('runWebhookTick combines enqueue + drain', async () => {
    await makeSubscription(['model.added'])
    await makeChange('model.added', NOW + 100)
    const { received, fetcher } = receiver()
    const tick = await runWebhookTick(db, { fetcher, now: NOW + 101 })
    expect(tick.enqueued).toBeGreaterThanOrEqual(1)
    expect(received.length).toBeGreaterThanOrEqual(1)
  })
})
