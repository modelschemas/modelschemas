import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'

import { getDb } from '../../db/index.ts'
import { endpoints, models, providers } from '../../db/schema.ts'
import { getModelDetail, listModelsCatalog } from '../catalog.ts'
import { assembleProviderOpenApi } from '../provider-openapi.ts'
import { FAL_ACTIVITY_MARKER, falProvider } from '../providers/fal.ts'
import type { ProviderConfig, SpecFetchResult } from '../providers/types.ts'
import { getEndpointSchema } from '../schemas-api.ts'
import { asyncApiMessageTypes, extractAsyncApiSchemas } from './asyncapi.ts'
import directorAsyncApi from './fixtures/fal-minimax-h3-max-director.asyncapi.json'
import { syncProvider } from './sync.ts'
import type { SyncDeps } from './sync.ts'

const NOW = 1_781_150_000
const DIRECTOR = 'minimax/h3-max/director'
const OPENAPI_MODEL = 'fal-ai/wma-open'
const GHOST = 'ghost/no-spec'

function wmaProvider(fetched: SpecFetchResult, id = 'fal'): ProviderConfig {
  return {
    ...falProvider,
    id,
    fetchSpec: () => Promise.resolve(fetched),
    listModels: () => Promise.resolve({ models: [] }),
  }
}

async function seedFal(db: SyncDeps['db']): Promise<SyncDeps> {
  await db
    .insert(providers)
    .values({
      id: 'fal',
      displayName: 'FAL',
      specSourceUrl: 'https://api.fal.ai/v1/models?expand=openapi-3.0',
    })
    .onConflictDoNothing()
  await db
    .insert(models)
    .values([
      {
        id: 'fal-minimax-h3-max-director',
        providerId: 'fal',
        rawId: DIRECTOR,
        activity: 'video',
        displayName: 'H3 Max Director',
        capabilities: { category: 'text-to-video' },
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      },
      {
        id: 'fal-fal-ai-wma-open',
        providerId: 'fal',
        rawId: OPENAPI_MODEL,
        activity: 'image',
        capabilities: { category: 'text-to-image' },
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      },
      {
        id: 'fal-ghost-no-spec',
        providerId: 'fal',
        rawId: GHOST,
        activity: 'image',
        capabilities: { category: 'text-to-image' },
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      },
    ])
    .onConflictDoNothing()
  let tick = NOW
  return {
    db,
    kv: env.SCHEMA_CACHE,
    secrets: {},
    now: () => tick++,
  }
}

function directorFetched(): SpecFetchResult {
  const extracted = extractAsyncApiSchemas(directorAsyncApi)
  return {
    specs: [
      {
        paths: {
          [`/${OPENAPI_MODEL}`]: {
            post: {
              [FAL_ACTIVITY_MARKER]: 'image',
              summary: 'Flux',
              requestBody: {
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: { prompt: { type: 'string' } },
                    },
                  },
                },
              },
              responses: {
                '200': {
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        properties: { id: { type: 'string' } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    ],
    sources: [
      {
        url: `https://api.fal.ai/v1/models?expand=openapi-3.0#${OPENAPI_MODEL}`,
        hash: 'openapi-source',
      },
    ],
    outputStrategy: 'post-200',
    bundledEndpoints: [
      {
        path: `/${DIRECTOR}`,
        activity: 'video',
        description: 'MiniMaxH3MaxDirector realtime client API',
        source: {
          url: 'https://fal.ai/api/apps/fal-ai/minimax-h3-max-director/asyncapi.json',
          hash: 'director-source',
        },
        derivation: 'upstream-spec',
        input: extracted.input,
        output: extracted.output,
        asyncapi: true,
      },
    ],
    asyncApiRawIds: [DIRECTOR],
  }
}

describe('FAL AsyncAPI ingest', () => {
  it('stores message schemas, flags the catalog, and leaves OpenAPI models alone', async () => {
    const db = getDb(env)
    const deps = await seedFal(db)
    const outcome = await syncProvider(deps, wmaProvider(directorFetched()))
    expect(outcome.error).toBeUndefined()
    expect(outcome.endpointsSeen).toBe(2)

    const input = await getEndpointSchema(db, 'fal', 'video', DIRECTOR, 'input')
    expect(input).not.toBeNull()
    expect(asyncApiMessageTypes(input?.schema)).toEqual(
      expect.arrayContaining(['configure', 'prompt']),
    )
    expect(input?.provenance).toMatchObject({
      derivation: 'upstream-spec',
      sourceUrl:
        'https://fal.ai/api/apps/fal-ai/minimax-h3-max-director/asyncapi.json',
    })

    const output = await getEndpointSchema(
      db,
      'fal',
      'video',
      DIRECTOR,
      'output',
    )
    expect(asyncApiMessageTypes(output?.schema)).toEqual(
      expect.arrayContaining(['session_info', 'chunk', 'error']),
    )

    const director = await getModelDetail(db, 'fal', DIRECTOR)
    expect(director?.capabilities).toEqual({
      category: 'text-to-video',
      asyncapi: true,
    })
    expect(director?.schemaEndpointId).toBe(DIRECTOR)

    const flagged = await listModelsCatalog(db, {
      provider: 'fal',
      capability: 'asyncapi',
    })
    expect(flagged.models.map((m) => m.rawId)).toContain(DIRECTOR)
    expect(flagged.models.map((m) => m.rawId)).not.toContain(OPENAPI_MODEL)
    expect(flagged.models.map((m) => m.rawId)).not.toContain(GHOST)

    const openapiModel = await getModelDetail(db, 'fal', OPENAPI_MODEL)
    expect(openapiModel?.capabilities).toEqual({ category: 'text-to-image' })
    const openapiInput = await getEndpointSchema(
      db,
      'fal',
      'image',
      OPENAPI_MODEL,
      'input',
    )
    expect(openapiInput?.schema).toMatchObject({
      properties: { prompt: { type: 'string' } },
    })

    expect(
      await getEndpointSchema(db, 'fal', 'image', GHOST, 'input'),
    ).toBeNull()
    const ghost = await getModelDetail(db, 'fal', GHOST)
    expect(ghost?.capabilities).toEqual({ category: 'text-to-image' })

    const assembled = await assembleProviderOpenApi(db, 'fal', {
      model: DIRECTOR,
    })
    expect(assembled).toMatchObject({
      ok: false,
      status: 404,
      code: 'unknown_model',
    })
    if (!assembled.ok) {
      expect(assembled.message).toContain('AsyncAPI')
    }

    const directorEndpoints = await db
      .select()
      .from(endpoints)
      .where(eq(endpoints.id, `fal/${DIRECTOR}`))
    expect(directorEndpoints[0]?.method).toBe('POST')
    expect(directorEndpoints[0]?.activity).toBe('video')
  })

  it('clears the catalog flag when a later sync finds no AsyncAPI models', async () => {
    const db = getDb(env)
    const id = 'fal-unflag'
    await db.insert(providers).values({
      id,
      displayName: 'FAL',
      specSourceUrl: 'https://example.com/fal.json',
    })
    await db.insert(models).values({
      id: 'fal-unflag-cleared-wma',
      providerId: id,
      rawId: 'cleared/wma',
      activity: 'video',
      capabilities: { category: 'text-to-video', asyncapi: true },
      firstSeenAt: NOW,
      lastSeenAt: NOW,
    })
    const deps: SyncDeps = {
      db,
      kv: env.SCHEMA_CACHE,
      secrets: {},
      now: () => NOW + 50,
    }
    await syncProvider(
      deps,
      wmaProvider(
        {
          specs: [],
          sources: [],
          outputStrategy: 'sibling-get',
          bundledEndpoints: [],
          asyncApiRawIds: [],
        },
        id,
      ),
    )
    const row = await db.query.models.findFirst({
      where: eq(models.id, 'fal-unflag-cleared-wma'),
    })
    expect(row?.capabilities).toEqual({ category: 'text-to-video' })
  })
})
