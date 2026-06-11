import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'

import { getDb } from '../../db/index.ts'
import {
  changes,
  endpoints,
  providers,
  schemaVersions,
} from '../../db/schema.ts'
import { getByHash } from '../kv.ts'
import type { OpenApiDocument, ProviderConfig } from '../providers/types.ts'
import { syncProvider } from './sync.ts'
import type { SyncDeps } from './sync.ts'

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` })

function fixtureSpec(maxTokens: boolean): OpenApiDocument {
  return {
    openapi: '3.1.0',
    paths: {
      '/v1/messages': {
        post: {
          summary: 'Create a message',
          requestBody: {
            content: { 'application/json': { schema: ref('CreateMessage') } },
          },
          responses: {
            '200': {
              content: { 'application/json': { schema: ref('Message') } },
            },
          },
        },
      },
      '/v1/admin/keys': {
        post: { requestBody: { content: {} }, responses: {} },
      },
    },
    components: {
      schemas: {
        CreateMessage: {
          type: 'object',
          properties: {
            model: { type: 'string' },
            ...(maxTokens ? { max_tokens: { type: 'integer' } } : {}),
          },
        },
        Message: { type: 'object', properties: { id: { type: 'string' } } },
      },
    },
  }
}

// D1 state persists across tests in the same isolate, so each test gets its
// own provider id and filters its queries by it.
function stubProvider(id: string, spec: OpenApiDocument): ProviderConfig {
  return {
    id,
    displayName: 'Stub',
    fetchSpec: () =>
      Promise.resolve({ specs: [spec], outputStrategy: 'post-200' as const }),
    listModels: () => Promise.resolve({ models: [] }),
    classify: (path) => (path === '/v1/messages' ? 'chat' : null),
  }
}

async function freshDeps(providerId: string): Promise<SyncDeps> {
  const db = getDb(env)
  await db.insert(providers).values({
    id: providerId,
    displayName: 'Stub',
    specSourceUrl: 'https://example.com/spec.json',
  })
  let tick = 1_781_150_000
  return { db, kv: env.SCHEMA_CACHE, secrets: {}, now: () => tick++ }
}

const providerChanges = (db: SyncDeps['db'], id: string) =>
  db.select().from(changes).where(eq(changes.providerId, id))
const providerEndpoints = (db: SyncDeps['db'], id: string) =>
  db.select().from(endpoints).where(eq(endpoints.providerId, id))

describe('syncProvider', () => {
  it('inserts on first run, no-ops on second, one schema.updated on mutation', async () => {
    const id = 'stub-main'
    const deps = await freshDeps(id)
    const db = deps.db

    // First run: endpoint + input/output versions inserted, KV warmed.
    const first = await syncProvider(deps, stubProvider(id, fixtureSpec(false)))
    expect(first.error).toBeUndefined()
    expect(first.endpointsSeen).toBe(1) // admin endpoint classified to null
    expect(first.versionsAdded).toBe(2)

    const endpointRows = await providerEndpoints(db, id)
    expect(endpointRows).toHaveLength(1)
    expect(endpointRows[0]?.id).toBe(`${id}/v1/messages`)
    expect(endpointRows[0]?.activity).toBe('chat')

    const firstChanges = await providerChanges(db, id)
    expect(firstChanges.map((c) => c.type).sort()).toEqual([
      'endpoint.added',
      'schema.added',
      'schema.added',
    ])

    const versions = await db
      .select()
      .from(schemaVersions)
      .where(eq(schemaVersions.endpointId, `${id}/v1/messages`))
    expect(versions).toHaveLength(2)
    const inputVersion = versions.find((v) => v.kind === 'input')
    expect(
      await getByHash(env.SCHEMA_CACHE, inputVersion?.contentHash ?? ''),
    ).toEqual({ type: 'object', properties: { model: { type: 'string' } } })

    const providerRow = await db.query.providers.findFirst({
      where: eq(providers.id, id),
    })
    expect(providerRow?.lastSyncedAt).not.toBeNull()
    expect(providerRow?.status).toBe('active')

    // Second run with the identical spec: fully idempotent.
    const second = await syncProvider(
      deps,
      stubProvider(id, fixtureSpec(false)),
    )
    expect(second.versionsAdded).toBe(0)
    expect(second.changesWritten).toBe(0)
    expect(await providerChanges(db, id)).toHaveLength(3)

    // Mutated input schema: exactly one schema.updated change, old version
    // superseded, new one current.
    const third = await syncProvider(deps, stubProvider(id, fixtureSpec(true)))
    expect(third.versionsAdded).toBe(1)
    expect(third.changesWritten).toBe(1)

    const updated = (await providerChanges(db, id)).filter(
      (c) => c.type === 'schema.updated',
    )
    expect(updated).toHaveLength(1)
    expect(updated[0]?.subjectId).toBe(`${id}/v1/messages`)

    const inputVersions = (
      await db
        .select()
        .from(schemaVersions)
        .where(eq(schemaVersions.endpointId, `${id}/v1/messages`))
    ).filter((v) => v.kind === 'input')
    expect(inputVersions).toHaveLength(2)
    expect(inputVersions.filter((v) => v.supersededAt === null)).toHaveLength(1)
    const payload = updated[0]?.payload as { previousHash: string }
    expect(payload.previousHash).toBe(inputVersion?.contentHash)
  })

  it('records endpoint.removed once when an endpoint vanishes from the spec', async () => {
    const id = 'stub-removal'
    const deps = await freshDeps(id)
    await syncProvider(deps, stubProvider(id, fixtureSpec(false)))

    const emptySpec: OpenApiDocument = {
      paths: {},
      components: { schemas: {} },
    }
    await syncProvider(deps, stubProvider(id, emptySpec))
    await syncProvider(deps, stubProvider(id, emptySpec)) // no duplicate change

    const removed = (await providerChanges(deps.db, id)).filter(
      (c) => c.type === 'endpoint.removed',
    )
    expect(removed).toHaveLength(1)
    // History rows survive removal.
    expect(await providerEndpoints(deps.db, id)).toHaveLength(1)
    expect(
      await deps.db
        .select()
        .from(schemaVersions)
        .where(eq(schemaVersions.endpointId, `${id}/v1/messages`)),
    ).toHaveLength(2)
  })

  it('reports skipped providers without touching the database', async () => {
    const id = 'stub-skipped'
    const deps = await freshDeps(id)
    const skippy: ProviderConfig = {
      ...stubProvider(id, fixtureSpec(false)),
      fetchSpec: () =>
        Promise.resolve({
          specs: [],
          outputStrategy: 'post-200' as const,
          skipped: 'stub: STUB_KEY not set — skipped',
        }),
    }
    const outcome = await syncProvider(deps, skippy)
    expect(outcome.skipped).toContain('STUB_KEY')
    expect(await providerEndpoints(deps.db, id)).toHaveLength(0)
    const providerRow = await deps.db.query.providers.findFirst({
      where: eq(providers.id, id),
    })
    expect(providerRow?.lastSyncedAt).toBeNull()
  })
})
