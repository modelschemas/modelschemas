import { beforeAll, describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'
import { eq, like } from 'drizzle-orm'

import { GPT_4O } from '../../packages/rate-card/src/fixtures/gpt-4o.ts'
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
    // Sorts first with no rows at all; `exp-also` sits between alpha and
    // beta with a model but no endpoint. Both test the comma joins.
    {
      id: 'exp-0none',
      displayName: 'Export None',
      specSourceUrl: 'https://example.com/0.json',
    },
    {
      id: 'exp-also',
      displayName: 'Export Also',
      specSourceUrl: 'https://example.com/s.json',
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
      pricing: GPT_4O,
      firstSeenAt: NOW - 50,
      lastSeenAt: NOW,
    },
    {
      id: 'exp-also-chat',
      providerId: 'exp-also',
      rawId: 'chat',
      activity: 'chat',
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
      specRevision: 'rev-7',
      sourceUrl: 'https://example.com/a.json',
      sourceHash: 'e'.repeat(64),
      extractorVersion: 'x1',
      derivation: 'upstream-spec',
      verifiedAt: '2026-10-01',
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
      'exp-also-chat',
      'exp-beta-old',
    ])
    expect(body.models[0]?.pricing).toEqual(GPT_4O)
    expect(body.models[2]?.deprecatedAt).toBe(NOW - 10)
    expect(body.providers.map((p) => p.id)).toEqual([
      'exp-0none',
      'exp-alpha',
      'exp-also',
      'exp-beta',
    ])
    expect(
      body.providers.filter((p) => p.id === 'exp-alpha' || p.id === 'exp-beta'),
    ).toEqual([
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
  })

  it('gives the same bytes after a poll that changed nothing else', async () => {
    const before = await exportText()
    await db
      .update(models)
      .set({ lastSeenAt: NOW + 900 })
      .where(like(models.providerId, 'exp-%'))
    await db
      .update(providers)
      .set({ lastPolledAt: NOW + 900, lastSyncedAt: NOW + 900 })
      .where(like(providers.id, 'exp-%'))
    expect(await exportText()).toBe(before)
  })

  it('streams one chunk per provider section, not one buffer', async () => {
    const reader = exportCatalogStream(db).getReader()
    let chunks = 0
    while (!(await reader.read()).done) chunks++
    // Opening, 3 model providers, the providers block, 2 schema providers,
    // close. Empty providers send nothing.
    expect(chunks).toBe(8)
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
        specRevision: 'rev-7',
        provenance: {
          sourceUrl: 'https://example.com/a.json',
          sourceHash: 'e'.repeat(64),
          fetchedAt: NOW - 20,
          extractorVersion: 'x1',
          derivation: 'upstream-spec',
          verifiedAt: '2026-10-01',
        },
      },
      output: { contentHash: 'd'.repeat(64) },
    })
    expect(text).toContain(`"schema":${INPUT_TEXT}`)
    expect(text).not.toContain('"type":"null"')
    expect(empty).toMatchObject({ input: null, output: null })
  })
})

describe('exportCatalogStream failures', () => {
  /** Reads until the stream errors; returns what arrived and the error. */
  async function readUntilError() {
    const reader = exportCatalogStream(db).getReader()
    const decoder = new TextDecoder()
    let text = ''
    try {
      for (;;) {
        const next = await reader.read()
        if (next.done) return { text, error: null }
        text += decoder.decode(next.value)
      }
    } catch (error) {
      return { text, error: error as Error }
    }
  }

  async function withVersion(
    row: typeof schemaVersions.$inferInsert,
    run: () => Promise<void>,
  ) {
    await db.insert(schemaVersions).values(row)
    try {
      await run()
    } finally {
      await db.delete(schemaVersions).where(eq(schemaVersions.id, row.id))
    }
  }

  it('errors part way on two current versions, leaving invalid JSON', async () => {
    await withVersion(
      {
        id: 'exp-alpha/v1/images:output:dup',
        endpointId: 'exp-alpha/v1/images',
        kind: 'output',
        contentHash: 'f'.repeat(64),
        schema: '{}',
        createdAt: NOW - 5,
      },
      async () => {
        const { text, error } = await readUntilError()
        expect(error?.message).toMatch(
          /schemas of exp-alpha: .*more than one current output version/,
        )
        // Models went out before the failure; the body still does not parse.
        expect(text).toContain('"exp-alpha-chat"')
        expect(() => JSON.parse(text) as unknown).toThrow()
      },
    )
  })

  it('errors on stored schema text that is not a JSON object', async () => {
    await withVersion(
      {
        id: 'exp-beta/v1/empty:input:bad',
        endpointId: 'exp-beta/v1/empty',
        kind: 'input',
        contentHash: '0'.repeat(64),
        schema: '',
        createdAt: NOW - 5,
      },
      async () => {
        const { error } = await readUntilError()
        expect(error?.message).toMatch(
          /exp-beta\/v1\/empty:input:bad is not a JSON object/,
        )
      },
    )
  })
})

describe('stableJson', () => {
  it('sorts nested keys, keeps array order, and drops undefined', () => {
    expect(stableJson({ b: [3, { y: 1, x: undefined }], a: null })).toBe(
      '{"a":null,"b":[3,{"y":1}]}',
    )
  })

  it('refuses a value JSON cannot hold instead of writing `undefined`', () => {
    expect(() => stableJson({ a: () => 1 })).toThrow(/function is not JSON/)
  })
})
