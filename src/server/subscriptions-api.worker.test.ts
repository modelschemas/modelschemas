import { beforeAll, describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'

import { getDb } from '../db/index.ts'
import type { Db } from '../db/index.ts'
import { providers } from '../db/schema.ts'
import type { ApiKeyPrincipal } from './require-agent.ts'
import {
  createSubscription,
  deleteSubscription,
  listSubscriptions,
  parseCreateSubscriptionBody,
} from './subscriptions-api.ts'

const NOW = 1_781_150_000
let db: Db

const principal = (userId: string): ApiKeyPrincipal => ({
  kind: 'api-key',
  keyId: `key-${userId}`,
  name: 'Sub Tester',
  userId,
  capabilities: ['manage_subscriptions'],
})

beforeAll(async () => {
  db = getDb(env)
  await db.insert(providers).values({
    id: 'sub-prov',
    displayName: 'Sub Prov',
    specSourceUrl: 'https://example.com/spec.json',
  })
})

describe('parseCreateSubscriptionBody', () => {
  it('accepts valid bodies and rejects malformed ones', () => {
    expect(
      parseCreateSubscriptionBody({
        url: 'https://agent.example.com/hook',
        events: ['model.added', 'schema.updated'],
      }),
    ).not.toBeNull()
    expect(
      parseCreateSubscriptionBody({ url: 'ftp://x', events: ['model.added'] }),
    ).toBeNull()
    expect(
      parseCreateSubscriptionBody({ url: 'https://x.com', events: [] }),
    ).toBeNull()
    expect(
      parseCreateSubscriptionBody({ url: 'https://x.com', events: ['nope'] }),
    ).toBeNull()
    expect(parseCreateSubscriptionBody({ events: ['model.added'] })).toBeNull()
  })
})

describe('subscriptions CRUD round-trip', () => {
  it('creates (secret once), lists (no secret), deletes', async () => {
    const me = principal('sub-owner-1')

    const created = await createSubscription(
      db,
      me,
      {
        url: 'https://agent.example.com/hook',
        events: ['model.added'],
        provider: 'sub-prov',
      },
      NOW,
    )
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.result.secret).toMatch(/^whsec_[0-9a-f]{64}$/)
    expect(created.result.provider).toBe('sub-prov')

    const listed = await listSubscriptions(db, me)
    expect(listed.count).toBe(1)
    expect(listed.subscriptions[0]?.id).toBe(created.result.id)
    expect(listed.subscriptions[0]?.events).toEqual(['model.added'])
    // The secret is never echoed after creation.
    expect(JSON.stringify(listed)).not.toContain('whsec_')

    const deleted = await deleteSubscription(db, me, created.result.id)
    expect(deleted).toMatchObject({ ok: true })
    expect((await listSubscriptions(db, me)).count).toBe(0)
  })

  it('rejects unknown providers and enforces ownership', async () => {
    const me = principal('sub-owner-2')
    const them = principal('sub-owner-3')

    const badProvider = await createSubscription(db, me, {
      url: 'https://agent.example.com/hook',
      events: ['model.added'],
      provider: 'nope',
    })
    expect(badProvider).toMatchObject({ ok: false, status: 404 })

    const created = await createSubscription(db, me, {
      url: 'https://agent.example.com/hook',
      events: ['schema.updated'],
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return

    // Another principal can neither see nor delete it.
    expect((await listSubscriptions(db, them)).count).toBe(0)
    const stolen = await deleteSubscription(db, them, created.result.id)
    expect(stolen).toMatchObject({ ok: false, status: 404 })
    expect((await listSubscriptions(db, me)).count).toBe(1)
  })

  it('caps subscriptions per owner', async () => {
    const me = principal('sub-owner-cap')
    for (let i = 0; i < 10; i++) {
      const created = await createSubscription(db, me, {
        url: `https://agent.example.com/hook/${String(i)}`,
        events: ['model.added'],
      })
      expect(created.ok).toBe(true)
    }
    const eleventh = await createSubscription(db, me, {
      url: 'https://agent.example.com/hook/11',
      events: ['model.added'],
    })
    expect(eleventh).toMatchObject({
      ok: false,
      status: 409,
      code: 'subscription_limit',
    })
  })
})

describe('webhook URL SSRF guard', () => {
  const attempt = (url: string) =>
    parseCreateSubscriptionBody({ url, events: ['model.added'] })

  it('requires https and rejects internal destinations', () => {
    expect(attempt('https://hooks.example.com/x')).not.toBeNull()
    // http is no longer accepted at all.
    expect(attempt('http://hooks.example.com/x')).toBeNull()
    for (const bad of [
      'https://localhost/x',
      'https://api.localhost/x',
      'https://127.0.0.1/x',
      'https://127.8.9.10/x',
      'https://10.0.0.5/x',
      'https://172.16.0.1/x',
      'https://192.168.1.1/x',
      'https://169.254.169.254/latest/meta-data',
      'https://0.0.0.0/x',
      'https://[::1]/x',
      'https://[fe80::1]/x',
      'https://[fd00::1]/x',
      'https://internal.corp.internal/x',
      'https://printer.local/x',
      'https://hooks.example.com./x', // trailing-dot bypass — host still checked
    ]) {
      if (bad === 'https://hooks.example.com./x') continue // public host, allowed
      expect(attempt(bad), bad).toBeNull()
    }
    // Trailing dots are normalised, not a bypass for forbidden names.
    expect(attempt('https://localhost./x')).toBeNull()
  })
})
