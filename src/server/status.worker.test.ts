import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'

import { getDb } from '../db/index.ts'
import {
  cacheMeta,
  endpoints,
  models,
  providers,
  schemaVersions,
} from '../db/schema.ts'
import { providerRegistry } from '../server/providers/index.ts'
import { getServiceStatus } from './status.ts'

const NOW = 1_781_150_000

describe('getServiceStatus', () => {
  it('reports per-provider sync state and counts', async () => {
    const db = getDb(env)
    await db.insert(providers).values([
      {
        id: 'status-a',
        displayName: 'Status A',
        specSourceUrl: 'https://example.com/a.json',
        lastPolledAt: NOW,
        lastSyncedAt: NOW - 100,
      },
      {
        id: 'status-b',
        displayName: 'Status B',
        specSourceUrl: 'https://example.com/b.json',
        status: 'degraded',
      },
    ])
    await db.insert(models).values([
      {
        id: 'status-a-model',
        providerId: 'status-a',
        rawId: 'model',
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      },
      {
        // A stored card counts as priced; a null column does not.
        id: 'status-a-priced',
        providerId: 'status-a',
        rawId: 'priced',
        pricing: { inputs: {}, tables: {}, price: 1, examples: [] },
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      },
      {
        // Chat without reasoning metadata: denominator only.
        id: 'status-a-chat',
        providerId: 'status-a',
        rawId: 'chat',
        activity: 'chat',
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      },
      {
        id: 'status-a-reasoner',
        providerId: 'status-a',
        rawId: 'reasoner',
        activity: 'chat',
        reasoning: { mode: 'effort', mandatory: false },
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      },
    ])
    await db.insert(endpoints).values({
      id: 'status-a/v1/things',
      providerId: 'status-a',
      activity: 'chat',
      method: 'POST',
      path: '/v1/things',
    })
    await db.insert(schemaVersions).values([
      {
        id: 'status-a/v1/things:input:current',
        endpointId: 'status-a/v1/things',
        kind: 'input',
        contentHash: 'c'.repeat(64),
        schema: '{}',
        createdAt: NOW,
      },
      {
        // Superseded version must not count.
        id: 'status-a/v1/things:input:old',
        endpointId: 'status-a/v1/things',
        kind: 'input',
        contentHash: 'd'.repeat(64),
        schema: '{}',
        createdAt: NOW - 10,
        supersededAt: NOW,
      },
    ])

    const status = await getServiceStatus(db, NOW)
    expect(status.service).toBe('modelschemas')
    const a = status.providers.find((p) => p.id === 'status-a')
    const b = status.providers.find((p) => p.id === 'status-b')
    expect(a).toMatchObject({
      status: 'active',
      lastPolledAt: NOW,
      lastSyncedAt: NOW - 100,
      counts: {
        models: 4,
        priced: 1,
        reasoning: 1,
        chat: 2,
        endpoints: 1,
        schemas: 1,
      },
    })
    expect(b).toMatchObject({
      status: 'degraded',
      lastPolledAt: null,
      counts: {
        models: 0,
        priced: 0,
        reasoning: 0,
        chat: 0,
        endpoints: 0,
        schemas: 0,
      },
    })
  })

  it('lists every registered provider even before its first sync', async () => {
    const db = getDb(env)
    const status = await getServiceStatus(db, NOW)
    // Nothing is seeded in the test DB, so every registry provider must
    // surface as pending — the full roster is always visible.
    for (const config of providerRegistry) {
      const listed = status.providers.find((p) => p.id === config.id)
      expect(listed).toMatchObject({
        displayName: config.displayName,
        status: 'pending',
        counts: {
          models: 0,
          priced: 0,
          reasoning: 0,
          chat: 0,
          endpoints: 0,
          schemas: 0,
        },
      })
    }
  })

  it('carries docs-failing and refused-clears records, and only those', async () => {
    const db = getDb(env)
    const ids = ['rec-none', 'rec-docs', 'rec-corrupt', 'rec-clears']
    await db.insert(providers).values(
      ids.map((id) => ({
        id,
        displayName: id,
        specSourceUrl: 'https://example.com/spec.json',
      })),
    )
    const docsFailing = {
      since: NOW - 1800,
      polls: 3,
      lastAt: NOW,
      failed: 2,
      skipped: 1,
      sources: ['https://example.com/docs/a', 'https://example.com/docs/b'],
      error: 'page changed shape',
    }
    const priceClearsRefused = {
      since: NOW - 900,
      polls: 2,
      lastAt: NOW,
      refused: 6,
      priced: 8,
    }
    const row = (key: string, lastError: string | null) => ({
      key,
      fetchedAt: NOW,
      staleTime: 0,
      lastError,
    })
    await db.insert(cacheMeta).values([
      row('docs-failing:rec-docs', JSON.stringify(docsFailing)),
      row(
        'price-clears-refused:rec-clears',
        JSON.stringify(priceClearsRefused),
      ),
      // Not JSON, JSON of the wrong shape, and no body at all.
      row('docs-failing:rec-corrupt', '{not json'),
      row('price-clears-refused:rec-corrupt', '"a string"'),
      row('docs-failing:rec-none', null),
      // Another cache_meta row is not a record.
      row('schema:rec-none', JSON.stringify(docsFailing)),
    ])

    const status = await getServiceStatus(db, NOW)
    const [none, docs, corrupt, clears] = ids.map((id) =>
      status.providers.find((p) => p.id === id),
    )
    expect(docs?.docsFailing).toEqual(docsFailing)
    expect(docs).not.toHaveProperty('priceClearsRefused')
    expect(clears?.priceClearsRefused).toEqual(priceClearsRefused)
    expect(clears).not.toHaveProperty('docsFailing')
    for (const healthy of [none, corrupt]) {
      expect(healthy).toMatchObject({ status: 'active' })
      expect(healthy).not.toHaveProperty('docsFailing')
      expect(healthy).not.toHaveProperty('priceClearsRefused')
    }
    // Neither record moves `status`.
    expect(docs?.status).toBe('active')
    expect(clears?.status).toBe('active')
  })
})
