/**
 * Webhook delivery (PLAN.md task 6.2). New `changes` rows are fanned out to
 * matching subscriptions as `webhook_deliveries`; delivery posts a signed
 * JSON payload (HMAC-SHA256 over the exact body, header
 * `X-ModelSchemas-Signature: sha256=<hex>`). Failures back off
 * exponentially via nextAttemptAt and are drained by the 15-minute cron;
 * after MAX_ATTEMPTS the subscription is auto-paused.
 */
import { and, eq, gt, lte } from 'drizzle-orm'

import type { Db } from '#/db/index.ts'
import {
  cacheMeta,
  changes,
  subscriptions,
  webhookDeliveries,
} from '#/db/schema.ts'

export const MAX_ATTEMPTS = 8
const ENQUEUE_CHECKPOINT_KEY = 'webhooks:enqueue-checkpoint'
const BASE_BACKOFF_SECONDS = 60

export async function signPayload(
  secret: string,
  body: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(body),
  )
  const hex = [...new Uint8Array(signature)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  return `sha256=${hex}`
}

/**
 * Fan out changes newer than the stored checkpoint to matching active
 * subscriptions. Returns the number of deliveries enqueued. Idempotent via
 * the checkpoint (a cache_meta row reusing fetchedAt as the high-water mark).
 */
export async function enqueueNewChanges(
  db: Db,
  now = Math.floor(Date.now() / 1000),
): Promise<number> {
  const checkpoint = await db.query.cacheMeta.findFirst({
    where: eq(cacheMeta.key, ENQUEUE_CHECKPOINT_KEY),
  })
  const since = checkpoint?.fetchedAt ?? 0

  const newChanges = await db
    .select()
    .from(changes)
    .where(gt(changes.createdAt, since))
    .orderBy(changes.createdAt)
  if (newChanges.length === 0) return 0

  const activeSubs = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.active, true))

  let enqueued = 0
  for (const change of newChanges) {
    for (const sub of activeSubs) {
      const events = Array.isArray(sub.events)
        ? (sub.events as Array<string>)
        : []
      if (!events.includes(change.type)) continue
      if (sub.providerFilter && sub.providerFilter !== change.providerId) {
        continue
      }
      await db.insert(webhookDeliveries).values({
        id: crypto.randomUUID(),
        subscriptionId: sub.id,
        changeId: change.id,
        attempt: 0,
        nextAttemptAt: now,
        status: 'pending',
      })
      enqueued++
    }
  }

  const highWater = newChanges[newChanges.length - 1]?.createdAt ?? now
  await db
    .insert(cacheMeta)
    .values({ key: ENQUEUE_CHECKPOINT_KEY, fetchedAt: highWater, staleTime: 0 })
    .onConflictDoUpdate({
      target: cacheMeta.key,
      set: { fetchedAt: highWater },
    })
  return enqueued
}

export interface DeliveryOutcome {
  deliveryId: string
  subscriptionId: string
  status: 'ok' | 'pending' | 'failed'
  responseCode: number | null
}

/**
 * Deliver everything due (pending, nextAttemptAt <= now). 2xx → ok;
 * failures back off exponentially (60s · 2^attempt); attempt MAX_ATTEMPTS
 * → delivery failed + subscription auto-paused.
 */
export async function deliverDue(
  db: Db,
  options?: {
    fetcher?: typeof globalThis.fetch
    limit?: number
    now?: number
  },
): Promise<Array<DeliveryOutcome>> {
  const fetcher = options?.fetcher ?? globalThis.fetch
  const now = options?.now ?? Math.floor(Date.now() / 1000)
  const limit = options?.limit ?? 50

  const due = await db
    .select()
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.status, 'pending'),
        lte(webhookDeliveries.nextAttemptAt, now),
      ),
    )
    .orderBy(webhookDeliveries.nextAttemptAt)
    .limit(limit)

  const outcomes: Array<DeliveryOutcome> = []
  for (const delivery of due) {
    const [sub, change] = await Promise.all([
      db.query.subscriptions.findFirst({
        where: eq(subscriptions.id, delivery.subscriptionId),
      }),
      db.query.changes.findFirst({
        where: eq(changes.id, delivery.changeId),
      }),
    ])
    if (!sub || !change || !sub.active) {
      await db
        .update(webhookDeliveries)
        .set({ status: 'failed' })
        .where(eq(webhookDeliveries.id, delivery.id))
      outcomes.push({
        deliveryId: delivery.id,
        subscriptionId: delivery.subscriptionId,
        status: 'failed',
        responseCode: null,
      })
      continue
    }

    const body = JSON.stringify({
      event: change.type,
      change: {
        id: change.id,
        type: change.type,
        provider: change.providerId,
        subjectId: change.subjectId,
        summary: change.summary,
        payload: change.payload,
        createdAt: change.createdAt,
      },
      _links: {
        changes: `/v1/changes?since=${String(change.createdAt)}`,
        provider: `/v1/providers/${change.providerId}/models`,
      },
    })

    let responseCode: number | null = null
    try {
      const response = await fetcher(sub.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-ModelSchemas-Signature': await signPayload(sub.secret, body),
          'X-ModelSchemas-Delivery': delivery.id,
        },
        body,
        // SSRF guard: never follow redirects — a receiver could otherwise
        // bounce the delivery to an internal target on the second hop. A 3xx
        // counts as a failed attempt.
        redirect: 'manual',
      })
      responseCode = response.status
    } catch {
      responseCode = null
    }

    if (responseCode !== null && responseCode >= 200 && responseCode < 300) {
      await db
        .update(webhookDeliveries)
        .set({ status: 'ok', lastResponseCode: responseCode })
        .where(eq(webhookDeliveries.id, delivery.id))
      outcomes.push({
        deliveryId: delivery.id,
        subscriptionId: sub.id,
        status: 'ok',
        responseCode,
      })
      continue
    }

    const attempt = delivery.attempt + 1
    if (attempt >= MAX_ATTEMPTS) {
      // Terminal: fail the delivery and auto-pause the subscription so a
      // dead receiver stops consuming the queue.
      await db
        .update(webhookDeliveries)
        .set({ status: 'failed', attempt, lastResponseCode: responseCode })
        .where(eq(webhookDeliveries.id, delivery.id))
      await db
        .update(subscriptions)
        .set({ active: false })
        .where(eq(subscriptions.id, sub.id))
      console.log(
        JSON.stringify({
          job: 'webhooks',
          event: 'subscription-paused',
          subscriptionId: sub.id,
          deliveryId: delivery.id,
          attempts: attempt,
        }),
      )
      outcomes.push({
        deliveryId: delivery.id,
        subscriptionId: sub.id,
        status: 'failed',
        responseCode,
      })
    } else {
      await db
        .update(webhookDeliveries)
        .set({
          attempt,
          lastResponseCode: responseCode,
          nextAttemptAt: now + BASE_BACKOFF_SECONDS * 2 ** attempt,
        })
        .where(eq(webhookDeliveries.id, delivery.id))
      outcomes.push({
        deliveryId: delivery.id,
        subscriptionId: sub.id,
        status: 'pending',
        responseCode,
      })
    }
  }
  return outcomes
}

/** Cron entry: fan out new changes, then drain due deliveries. */
export async function runWebhookTick(
  db: Db,
  options?: Parameters<typeof deliverDue>[1],
): Promise<{ enqueued: number; outcomes: Array<DeliveryOutcome> }> {
  const enqueued = await enqueueNewChanges(db, options?.now)
  const outcomes = await deliverDue(db, options)
  return { enqueued, outcomes }
}
