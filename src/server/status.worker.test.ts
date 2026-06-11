import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'

import { getDb } from '../db/index.ts'
import { endpoints, models, providers, schemaVersions } from '../db/schema.ts'
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
    await db.insert(models).values({
      id: 'status-a-model',
      providerId: 'status-a',
      rawId: 'model',
      firstSeenAt: NOW,
      lastSeenAt: NOW,
    })
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
      counts: { models: 1, endpoints: 1, schemas: 1 },
    })
    expect(b).toMatchObject({
      status: 'degraded',
      lastPolledAt: null,
      counts: { models: 0, endpoints: 0, schemas: 0 },
    })
  })
})
