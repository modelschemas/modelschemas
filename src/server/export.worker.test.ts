import { beforeAll, describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'

import { getDb } from '../db/index.ts'
import type { Db } from '../db/index.ts'
import {
  changes,
  endpoints,
  models,
  providerModelNamespaces,
  providers,
  schemaVersions,
} from '../db/schema.ts'
import { exportCatalogStream, stableJson } from './export.ts'

const NOW = 1_781_150_000
// Key order is the provider's, not sorted: the export keeps it.
const INPUT_TEXT = JSON.stringify({
  type: 'object',
  properties: { prompt: { type: 'string' }, model: { type: 'string' } },
})
const OUTPUT_TEXT = JSON.stringify({ type: 'object' })

let db: Db

beforeAll(async () => {
  db = getDb(env)
  await db.insert(providers).values([
    {
      id: 'exp-beta',
      displayName: 'Export Beta',
      specSourceUrl: 'https://example.com/b.json',
      lastPolledAt: NOW,
      lastSyncedAt: NOW,
    },
    {
      id: 'exp-alpha',
      displayName: 'Export Alpha',
      specSourceUrl: 'https://example.com/a.json',
      lastPolledAt: NOW,
    },
  ])
  await db
    .insert(providerModelNamespaces)
    .values({ namespace: 'alpha', providerId: 'exp-alpha' })
  await db.insert(models).values([
    {
      id: 'exp-alpha-chat',
      providerId: 'exp-alpha',
      rawId: 'chat-1',
      activity: 'chat',
      capabilities: { vision: true, tools: false },
      firstSeenAt: NOW - 50,
      lastSeenAt: NOW,
    },
    {
      id: 'exp-beta-old',
      providerId: 'exp-beta',
      rawId: 'old',
      activity: 'chat',
      firstSeenAt: NOW - 50,
      lastSeenAt: NOW - 10,
      deprecatedAt: NOW - 10,
    },
  ])
  await db.insert(endpoints).values([
    {
      id: 'exp-alpha/v1/images',
      providerId: 'exp-alpha',
      activity: 'image',
      method: 'POST',
      path: '/v1/images',
    },
    {
      id: 'exp-beta/v1/empty',
      providerId: 'exp-beta',
      activity: 'chat',
      method: 'POST',
      path: '/v1/empty',
    },
  ])
  await db.insert(schemaVersions).values([
    {
      id: 'exp-alpha/v1/images:input:current',
      endpointId: 'exp-alpha/v1/images',
      kind: 'input',
      contentHash: 'c'.repeat(64),
      schema: INPUT_TEXT,
      derivation: 'upstream-spec',
      createdAt: NOW - 20,
    },
    {
      id: 'exp-alpha/v1/images:input:old',
      endpointId: 'exp-alpha/v1/images',
      kind: 'input',
      contentHash: 'b'.repeat(64),
      schema: '{"type":"null"}',
      createdAt: NOW - 40,
      supersededAt: NOW - 20,
    },
    {
      id: 'exp-alpha/v1/images:output:current',
      endpointId: 'exp-alpha/v1/images',
      kind: 'output',
      contentHash: 'd'.repeat(64),
      schema: OUTPUT_TEXT,
      createdAt: NOW - 20,
    },
  ])
  await db.insert(changes).values([
    {
      id: 'chg-a',
      type: 'model.added',
      providerId: 'exp-alpha',
      subjectId: 'exp-alpha-chat',
      summary: 'added',
      createdAt: NOW - 50,
    },
    {
      id: 'chg-b',
      type: 'model.removed',
      providerId: 'exp-beta',
      subjectId: 'exp-beta-old',
      summary: 'removed',
      createdAt: NOW - 10,
    },
  ])
})

const exportText = () => new Response(exportCatalogStream(db)).text()

interface ExportBody {
  latestChange: unknown
  models: Array<Record<string, unknown>>
  providers: Array<Record<string, unknown>>
  schemas: Array<Record<string, unknown>>
}

describe('exportCatalogStream', () => {
  it('serves the whole catalog with the newest change', async () => {
    const body = JSON.parse(await exportText()) as ExportBody
    expect(Object.keys(body)).toEqual([
      'latestChange',
      'models',
      'providers',
      'schemas',
    ])
    expect(body.latestChange).toEqual({ createdAt: NOW - 10, id: 'chg-b' })
    expect(body.models.map((m) => m.id)).toEqual([
      'exp-alpha-chat',
      'exp-beta-old',
    ])
    expect(body.models[1]?.deprecatedAt).toBe(NOW - 10)
    expect(body.providers).toEqual([
      {
        authEnvVar: null,
        displayName: 'Export Alpha',
        id: 'exp-alpha',
        modelNamespaces: ['alpha'],
        modelsEndpoint: null,
        specSourceUrl: 'https://example.com/a.json',
        status: 'active',
      },
      {
        authEnvVar: null,
        displayName: 'Export Beta',
        id: 'exp-beta',
        modelNamespaces: [],
        modelsEndpoint: null,
        specSourceUrl: 'https://example.com/b.json',
        status: 'active',
      },
    ])
  })

  it('leaves out fields that change on every poll and sorts keys', async () => {
    const text = await exportText()
    for (const field of ['lastSeenAt', 'lastPolledAt', 'lastSyncedAt']) {
      expect(text).not.toContain(`"${field}"`)
    }
    const body = JSON.parse(text) as ExportBody
    const model = body.models[0] ?? {}
    expect(model._links).toBeUndefined()
    expect(model.firstSeenAt).toBe(NOW - 50)
    expect(Object.keys(model)).toEqual(Object.keys(model).sort())
    expect(model.capabilities).toEqual({ tools: false, vision: true })
    expect(text).toContain('"capabilities":{"tools":false,"vision":true}')
    expect(await exportText()).toBe(text)
  })

  it('serves current schema versions with their stored text', async () => {
    const text = await exportText()
    const body = JSON.parse(text) as ExportBody
    expect(body.schemas.map((s) => s.endpointId)).toEqual([
      'v1/images',
      'v1/empty',
    ])
    const [images, empty] = body.schemas
    expect(images).toMatchObject({
      provider: 'exp-alpha',
      activity: 'image',
      method: 'POST',
      path: '/v1/images',
      input: {
        contentHash: 'c'.repeat(64),
        provenance: { derivation: 'upstream-spec', fetchedAt: NOW - 20 },
      },
      output: { contentHash: 'd'.repeat(64) },
    })
    expect(text).toContain(`"schema":${INPUT_TEXT}`)
    expect(text).not.toContain('"type":"null"')
    expect(empty).toMatchObject({ input: null, output: null })
  })
})

describe('stableJson', () => {
  it('sorts nested keys, keeps array order, and drops undefined', () => {
    expect(stableJson({ b: [3, { y: 1, x: undefined }], a: null })).toBe(
      '{"a":null,"b":[3,{"y":1}]}',
    )
  })
})
