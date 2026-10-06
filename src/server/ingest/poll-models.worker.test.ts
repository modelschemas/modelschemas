import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'

import { getDb } from '../../db/index.ts'
import {
  changes,
  endpoints,
  models,
  providers,
  schemaVersions,
} from '../../db/schema.ts'
import { parseHuggingFaceModels } from '../providers/adapters/huggingface.ts'
import { tryDocs, unavailable } from '../providers/model-facts.ts'
import type {
  DocsFailure,
  ModelInfo,
  ProviderConfig,
} from '../providers/types.ts'
import { runIngestScope, takeIngestEvents } from './ingest-signals.ts'
import {
  modelDbId,
  pollAllProviders,
  pollProviderModels,
} from './poll-models.ts'
import { MODELS_DEV_API_URL } from './retire-models-dev.ts'
import type { SyncDeps } from './sync.ts'

function stubProvider(id: string, list: Array<ModelInfo>): ProviderConfig {
  return {
    id,
    displayName: 'Stub',
    defaultDerivation: 'upstream-spec',
    fetchSpec: () =>
      Promise.resolve({
        specs: [],
        sources: [],
        outputStrategy: 'post-200' as const,
      }),
    listModels: () => Promise.resolve({ models: list }),
    classify: () => null,
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

const fable: ModelInfo = {
  rawId: 'claude-fable-5',
  displayName: 'Claude Fable 5',
  activity: 'chat',
  contextWindow: 200_000,
}
const haiku: ModelInfo = {
  rawId: 'claude-haiku-4-5',
  displayName: 'Claude Haiku 4.5',
  activity: 'chat',
}

describe('pollProviderModels', () => {
  it('covers add / no-change / update / remove cycles', async () => {
    const id = 'poll-main'
    const deps = await freshDeps(id)
    const db = deps.db

    // Add: both models inserted with model.added changes.
    const first = await pollProviderModels(
      deps,
      stubProvider(id, [fable, haiku]),
    )
    expect(first).toMatchObject({ added: 2, removed: 0, updated: 0 })
    const rows = await db.select().from(models).where(eq(models.providerId, id))
    expect(rows).toHaveLength(2)
    expect(rows.map((m) => m.id).sort()).toEqual([
      modelDbId(id, 'claude-fable-5'),
      modelDbId(id, 'claude-haiku-4-5'),
    ])

    // No-change: lastSeenAt bumps, zero changes written.
    const second = await pollProviderModels(
      deps,
      stubProvider(id, [fable, haiku]),
    )
    expect(second).toMatchObject({ added: 0, removed: 0, updated: 0 })
    const afterSecond = await db
      .select()
      .from(models)
      .where(eq(models.id, modelDbId(id, 'claude-fable-5')))
    expect(afterSecond[0]?.lastSeenAt).toBeGreaterThan(
      afterSecond[0]?.firstSeenAt ?? 0,
    )
    expect(
      await db.select().from(changes).where(eq(changes.providerId, id)),
    ).toHaveLength(2)

    // Update: context window grows → one model.updated with before/after.
    const third = await pollProviderModels(
      deps,
      stubProvider(id, [{ ...fable, contextWindow: 500_000 }, haiku]),
    )
    expect(third).toMatchObject({ added: 0, removed: 0, updated: 1 })
    const updatedChange = (
      await db.select().from(changes).where(eq(changes.providerId, id))
    ).find((c) => c.type === 'model.updated')
    const payload = updatedChange?.payload as {
      before: { contextWindow: number }
      after: { contextWindow: number }
    }
    expect(payload.before.contextWindow).toBe(200_000)
    expect(payload.after.contextWindow).toBe(500_000)

    // Remove: haiku vanishes → deprecatedAt set + model.removed, once.
    const fourth = await pollProviderModels(
      deps,
      stubProvider(id, [{ ...fable, contextWindow: 500_000 }]),
    )
    expect(fourth).toMatchObject({ added: 0, removed: 1, updated: 0 })
    const fifth = await pollProviderModels(
      deps,
      stubProvider(id, [{ ...fable, contextWindow: 500_000 }]),
    )
    expect(fifth.removed).toBe(0) // already deprecated — no duplicate change
    const haikuRow = await db
      .select()
      .from(models)
      .where(eq(models.id, modelDbId(id, 'claude-haiku-4-5')))
    expect(haikuRow[0]?.deprecatedAt).not.toBeNull()

    // Reappearance clears deprecation via model.updated.
    const sixth = await pollProviderModels(
      deps,
      stubProvider(id, [{ ...fable, contextWindow: 500_000 }, haiku]),
    )
    expect(sixth.updated).toBe(1)
    const haikuBack = await db
      .select()
      .from(models)
      .where(eq(models.id, modelDbId(id, 'claude-haiku-4-5')))
    expect(haikuBack[0]?.deprecatedAt).toBeNull()

    // lastPolledAt recorded on the provider.
    const providerRow = await db.query.providers.findFirst({
      where: eq(providers.id, id),
    })
    expect(providerRow?.lastPolledAt).not.toBeNull()
  })

  it('preserves capabilities.asyncapi when the listing omits it', async () => {
    const id = 'poll-asyncapi'
    const deps = await freshDeps(id)
    const rawId = 'minimax/h3-max/director'
    await pollProviderModels(
      deps,
      stubProvider(id, [
        {
          rawId,
          activity: 'video',
          capabilities: { category: 'text-to-video', asyncapi: true },
        },
      ]),
    )
    const again = await pollProviderModels(
      deps,
      stubProvider(id, [
        {
          rawId,
          activity: 'video',
          capabilities: { category: 'text-to-video' },
        },
      ]),
    )
    expect(again).toMatchObject({ added: 0, removed: 0, updated: 0 })
    const row = await deps.db.query.models.findFirst({
      where: eq(models.id, modelDbId(id, rawId)),
    })
    expect(row?.capabilities).toEqual({
      category: 'text-to-video',
      asyncapi: true,
    })
  })

  it('bulk-bumps lastSeenAt across chunk boundaries for unchanged models', async () => {
    const id = 'poll-bulk'
    const deps = await freshDeps(id)
    // 200 models spans three 90-id UPDATE chunks.
    const herd: Array<ModelInfo> = Array.from({ length: 200 }, (_, i) => ({
      rawId: `model-${String(i)}`,
      displayName: `Model ${String(i)}`,
      activity: 'chat',
    }))

    const first = await pollProviderModels(deps, stubProvider(id, herd))
    expect(first).toMatchObject({ added: 200, removed: 0, updated: 0 })

    const second = await pollProviderModels(deps, stubProvider(id, herd))
    expect(second).toMatchObject({ added: 0, removed: 0, updated: 0 })
    const rows = await deps.db
      .select()
      .from(models)
      .where(eq(models.providerId, id))
    expect(rows).toHaveLength(200)
    for (const row of rows) {
      expect(row.lastSeenAt).toBeGreaterThan(row.firstSeenAt)
    }

    // Fleet-wide backdate (the first-pass-after-deploy shape) spans seven
    // 30-row CASE chunks; each row gets its own date.
    const BASE = 1_700_000_000
    const dated = herd.map((m, i) => ({ ...m, releasedAt: BASE + i }))
    const third = await pollProviderModels(deps, stubProvider(id, dated))
    expect(third).toMatchObject({ added: 0, updated: 0, backdated: 200 })
    const backdatedRows = await deps.db
      .select()
      .from(models)
      .where(eq(models.providerId, id))
    for (const row of backdatedRows) {
      const i = Number(row.rawId.replace('model-', ''))
      expect(row.firstSeenAt).toBe(BASE + i)
      expect(row.lastSeenAt).toBeGreaterThan(row.firstSeenAt)
    }

    // Converged: the same dates no longer count as backdates.
    const fourth = await pollProviderModels(deps, stubProvider(id, dated))
    expect(fourth).toMatchObject({ backdated: 0 })
  }, 15_000)

  it('backdates firstSeenAt to the upstream release date (issue #1)', async () => {
    const id = 'poll-backdate'
    const deps = await freshDeps(id)
    const db = deps.db
    const RELEASE = 1_700_000_000 // well before the test clock's 1_781_150_000

    // Insert: a reported release date becomes firstSeenAt directly.
    const first = await pollProviderModels(
      deps,
      stubProvider(id, [{ ...fable, releasedAt: RELEASE }]),
    )
    expect(first).toMatchObject({ added: 1 })
    const fableId = modelDbId(id, 'claude-fable-5')
    let row = await db.select().from(models).where(eq(models.id, fableId))
    expect(row[0]?.firstSeenAt).toBe(RELEASE)
    expect(row[0]?.lastSeenAt).toBeGreaterThan(RELEASE)

    // Insert without a date: poll-time firstSeenAt, as before.
    await pollProviderModels(deps, stubProvider(id, [fable, haiku]))
    const haikuId = modelDbId(id, 'claude-haiku-4-5')
    let haikuRow = await db.select().from(models).where(eq(models.id, haikuId))
    expect(haikuRow[0]?.firstSeenAt).toBeGreaterThan(RELEASE)
    const observedFirstSeen = haikuRow[0]?.firstSeenAt ?? 0
    const changeCount = (
      await db.select().from(changes).where(eq(changes.providerId, id))
    ).length

    // Existing otherwise-unchanged row gains a date → backdated silently
    // (no model.updated event), lastSeenAt still bumped.
    const backfill = await pollProviderModels(
      deps,
      stubProvider(id, [fable, { ...haiku, releasedAt: RELEASE + 1 }]),
    )
    expect(backfill).toMatchObject({ updated: 0, backdated: 1 })
    haikuRow = await db.select().from(models).where(eq(models.id, haikuId))
    expect(haikuRow[0]?.firstSeenAt).toBe(RELEASE + 1)
    expect(haikuRow[0]?.lastSeenAt).toBeGreaterThan(observedFirstSeen)
    expect(
      await db.select().from(changes).where(eq(changes.providerId, id)),
    ).toHaveLength(changeCount)

    // Never forward-dates: a later/bogus releasedAt leaves firstSeenAt alone.
    const noop = await pollProviderModels(
      deps,
      stubProvider(id, [
        { ...fable, releasedAt: RELEASE + 999_999_999 }, // future
        { ...haiku, releasedAt: 0 }, // bogus
      ]),
    )
    expect(noop.backdated).toBe(0)
    row = await db.select().from(models).where(eq(models.id, fableId))
    haikuRow = await db.select().from(models).where(eq(models.id, haikuId))
    expect(row[0]?.firstSeenAt).toBe(RELEASE)
    expect(haikuRow[0]?.firstSeenAt).toBe(RELEASE + 1)

    // Backdate composes with a real update: firstSeenAt and the mutable
    // field change land together, and the update event still fires.
    const combo = await pollProviderModels(
      deps,
      stubProvider(id, [
        { ...fable, contextWindow: 500_000, releasedAt: RELEASE - 50 },
        { ...haiku, releasedAt: RELEASE + 1 },
      ]),
    )
    expect(combo).toMatchObject({ updated: 1, backdated: 1 })
    row = await db.select().from(models).where(eq(models.id, fableId))
    expect(row[0]?.firstSeenAt).toBe(RELEASE - 50)
    expect(row[0]?.contextWindow).toBe(500_000)
  })

  it('reports skipped providers without touching the database', async () => {
    const id = 'poll-skipped'
    const deps = await freshDeps(id)
    const skippy: ProviderConfig = {
      ...stubProvider(id, [fable]),
      listModels: () =>
        Promise.resolve({
          models: [],
          skipped: 'stub: STUB_KEY not set — skipped',
        }),
    }
    const outcome = await pollProviderModels(deps, skippy)
    expect(outcome.skipped).toContain('STUB_KEY')
    expect(
      await deps.db.select().from(models).where(eq(models.providerId, id)),
    ).toHaveLength(0)
    const providerRow = await deps.db.query.providers.findFirst({
      where: eq(providers.id, id),
    })
    expect(providerRow?.lastPolledAt).toBeNull()
  })

  it('slugifies raw ids with slashes and dots', () => {
    expect(modelDbId('fal', 'fal-ai/flux/dev')).toBe('fal-fal-ai-flux-dev')
    expect(modelDbId('openrouter', 'openai/gpt-4.1')).toBe(
      'openrouter-openai-gpt-4-1',
    )
  })

  it('fills request-feature flags from the bound input schema', async () => {
    const id = 'poll-schema'
    const deps = await freshDeps(id)
    const db = deps.db
    await db.insert(endpoints).values({
      id: `${id}/v1/messages`,
      providerId: id,
      activity: 'chat',
      method: 'POST',
      path: '/v1/messages',
    })
    await db.insert(schemaVersions).values({
      id: `${id}/v1/messages:input`,
      endpointId: `${id}/v1/messages`,
      kind: 'input',
      contentHash: 'a'.repeat(64),
      schema: JSON.stringify({
        properties: {
          tools: { type: 'array' },
          temperature: { type: 'number' },
        },
      }),
      derivation: 'upstream-spec',
      sourceUrl: 'https://example.com/openapi.json',
      createdAt: 1_781_150_000,
    })
    const outcome = await pollProviderModels(deps, {
      ...stubProvider(id, [
        {
          rawId: 'claude-sonnet-4-5',
          activity: 'chat',
          contextWindow: 200_000,
          schemaEndpointId: 'v1/messages',
        },
      ]),
    })
    expect(outcome.added).toBe(1)
    const row = await db
      .select()
      .from(models)
      .where(eq(models.id, modelDbId(id, 'claude-sonnet-4-5')))
    expect(row[0]?.capabilities).toEqual(['tools', 'temperature'])
    const sources = row[0]?.factSources as {
      contextWindow?: { derivation: string }
      capabilities?: Record<string, { derivation: string; endpointId?: string }>
    }
    expect(sources.contextWindow?.derivation).toBe('listing')
    expect(sources.capabilities?.tools).toMatchObject({
      derivation: 'upstream-spec',
      endpointId: 'v1/messages',
    })
  })

  it('binds a listed route only once its input schema is synced', async () => {
    const id = 'poll-synced-routes'
    const deps = await freshDeps(id)
    const provider = {
      ...stubProvider(id, [
        {
          rawId: 'acme/llm',
          activity: 'chat',
          schemaEndpointId: 'models/acme/llm/predictions',
        },
      ]),
      bindSyncedRoutesOnly: true,
    }
    const stored = async () =>
      (
        await deps.db
          .select()
          .from(models)
          .where(eq(models.id, modelDbId(id, 'acme/llm')))
      )[0]?.schemaEndpointId

    // Poll before the sync has created the route: no link to a 404.
    await pollProviderModels(deps, provider)
    expect(await stored()).toBeNull()

    await deps.db.insert(endpoints).values({
      id: `${id}/models/acme/llm/predictions`,
      providerId: id,
      activity: 'chat',
      method: 'POST',
      path: '/models/acme/llm/predictions',
    })
    await deps.db.insert(schemaVersions).values({
      id: `${id}/models/acme/llm/predictions:input`,
      endpointId: `${id}/models/acme/llm/predictions`,
      kind: 'input',
      contentHash: 'b'.repeat(64),
      schema: JSON.stringify({ properties: { input: { type: 'object' } } }),
      derivation: 'upstream-spec',
      createdAt: 1_781_150_000,
    })
    await pollProviderModels(deps, provider)
    expect(await stored()).toBe('models/acme/llm/predictions')

    // Without the flag a listed route is stored as listed.
    const plain = 'poll-listed-routes'
    const plainDeps = await freshDeps(plain)
    await pollProviderModels(
      plainDeps,
      stubProvider(plain, [
        {
          rawId: 'acme/llm',
          activity: 'chat',
          schemaEndpointId: 'v1/unsynced',
        },
      ]),
    )
    const row = await plainDeps.db
      .select()
      .from(models)
      .where(eq(models.id, modelDbId(plain, 'acme/llm')))
    expect(row[0]?.schemaEndpointId).toBe('v1/unsynced')
  })

  it('does not walk generated specs onto catalog rows', async () => {
    const id = 'poll-generated'
    const deps = await freshDeps(id)
    await deps.db.insert(endpoints).values({
      id: `${id}/v1/messages`,
      providerId: id,
      activity: 'chat',
      method: 'POST',
      path: '/v1/messages',
    })
    await deps.db.insert(schemaVersions).values({
      id: `${id}/v1/messages:input`,
      endpointId: `${id}/v1/messages`,
      kind: 'input',
      contentHash: 'a'.repeat(64),
      schema: JSON.stringify({
        properties: { tools: { type: 'array' } },
      }),
      derivation: 'upstream-spec',
      createdAt: 1_781_150_000,
    })
    await pollProviderModels(deps, {
      ...stubProvider(id, [
        {
          rawId: 'deepseek-chat',
          activity: 'chat',
          schemaEndpointId: 'v1/messages',
        },
      ]),
      defaultDerivation: 'generated',
    })
    const row = await deps.db
      .select()
      .from(models)
      .where(eq(models.id, modelDbId(id, 'deepseek-chat')))
    expect(row[0]?.capabilities).toBeNull()
  })

  it('does not emit model.updated when only schema provenance metadata changes', async () => {
    const id = 'poll-sources'
    const deps = await freshDeps(id)
    await deps.db.insert(endpoints).values({
      id: `${id}/v1/messages`,
      providerId: id,
      activity: 'chat',
      method: 'POST',
      path: '/v1/messages',
    })
    await deps.db.insert(schemaVersions).values({
      id: `${id}/v1/messages:input`,
      endpointId: `${id}/v1/messages`,
      kind: 'input',
      contentHash: 'a'.repeat(64),
      schema: JSON.stringify({
        properties: { tools: { type: 'array' } },
      }),
      derivation: 'upstream-spec',
      sourceHash: 'a'.repeat(64),
      createdAt: 1_781_150_000,
    })
    const listed = stubProvider(id, [
      {
        rawId: 'claude-sonnet-4-5',
        activity: 'chat',
        schemaEndpointId: 'v1/messages',
      },
    ])
    expect(await pollProviderModels(deps, listed)).toMatchObject({
      added: 1,
      updated: 0,
    })
    await deps.db
      .update(schemaVersions)
      .set({ sourceHash: 'b'.repeat(64), createdAt: 1_781_150_100 })
      .where(eq(schemaVersions.id, `${id}/v1/messages:input`))
    expect(await pollProviderModels(deps, listed)).toMatchObject({
      added: 0,
      updated: 0,
    })
  })

  it('stores OpenRouter listings as rate cards and Together zeros as null', async () => {
    const id = 'poll-pricing'
    const deps = await freshDeps(id)
    const listing = { prompt: '0.0000025', completion: '0.00001' }
    const first = await pollProviderModels(
      deps,
      stubProvider(id, [
        { rawId: 'gpt-4o', activity: 'chat', pricing: listing },
        {
          rawId: 'free-model',
          activity: 'chat',
          pricing: { prompt: '0', completion: '0' },
        },
      ]),
    )
    expect(first).toMatchObject({ added: 2, updated: 0 })
    const gpt = await deps.db.query.models.findFirst({
      where: eq(models.id, modelDbId(id, 'gpt-4o')),
    })
    const free = await deps.db.query.models.findFirst({
      where: eq(models.id, modelDbId(id, 'free-model')),
    })
    const card = gpt?.pricing as { inputs?: { input_tokens?: unknown } } | null
    expect(card?.inputs?.input_tokens).toMatchObject({
      param: 'input_tokens',
      bound: 'usage',
    })
    expect(free?.pricing).toBeNull()
    expect(
      (gpt?.factSources as { pricing?: { derivation: string } } | null)?.pricing
        ?.derivation,
    ).toBe('listing')
    expect(
      (free?.factSources as { pricing?: unknown } | null)?.pricing,
    ).toBeUndefined()

    const second = await pollProviderModels(
      deps,
      stubProvider(id, [
        { rawId: 'gpt-4o', activity: 'chat', pricing: listing },
        {
          rawId: 'free-model',
          activity: 'chat',
          pricing: { prompt: '0', completion: '0' },
        },
      ]),
    )
    expect(second).toMatchObject({ added: 0, updated: 0 })
  })

  it('emits model.updated when OpenRouter listing rates change', async () => {
    const id = 'poll-price-change'
    const deps = await freshDeps(id)
    await pollProviderModels(
      deps,
      stubProvider(id, [
        {
          rawId: 'gpt-4o',
          activity: 'chat',
          pricing: { prompt: '0.0000025', completion: '0.00001' },
        },
      ]),
    )
    const first = await deps.db.query.models.findFirst({
      where: eq(models.id, modelDbId(id, 'gpt-4o')),
    })
    const firstHash = (first?.pricing as { source?: { hash: string } } | null)
      ?.source?.hash
    const raised = await pollProviderModels(
      deps,
      stubProvider(id, [
        {
          rawId: 'gpt-4o',
          activity: 'chat',
          pricing: { prompt: '0.000005', completion: '0.00002' },
        },
      ]),
    )
    expect(raised).toMatchObject({ added: 0, updated: 1 })
    const later = await deps.db.query.models.findFirst({
      where: eq(models.id, modelDbId(id, 'gpt-4o')),
    })
    const laterHash = (later?.pricing as { source?: { hash: string } } | null)
      ?.source?.hash
    expect(firstHash).toBeTruthy()
    expect(laterHash).toBeTruthy()
    expect(laterHash).not.toBe(firstHash)
  })

  it('drops a stored card when the listing becomes all-zero', async () => {
    const id = 'poll-price-drop'
    const deps = await freshDeps(id)
    await pollProviderModels(
      deps,
      stubProvider(id, [
        {
          rawId: 'gpt-4o',
          activity: 'chat',
          pricing: { prompt: '0.0000025', completion: '0.00001' },
        },
      ]),
    )
    const errors: Array<string> = []
    const original = console.error
    console.error = (message?: unknown) => {
      errors.push(String(message))
    }
    try {
      const dropped = await pollProviderModels(
        deps,
        stubProvider(id, [
          {
            rawId: 'gpt-4o',
            activity: 'chat',
            pricing: { prompt: '0', completion: '0' },
          },
        ]),
      )
      expect(dropped).toMatchObject({ added: 0, updated: 1 })
    } finally {
      console.error = original
    }
    const row = await deps.db.query.models.findFirst({
      where: eq(models.id, modelDbId(id, 'gpt-4o')),
    })
    expect(row?.pricing).toBeNull()
    expect(
      (row?.factSources as { pricing?: unknown } | null)?.pricing,
    ).toBeUndefined()
    expect(errors.some((line) => line.includes('uncompilable'))).toBe(true)
  })

  it('refuses a request-bound param that is not on the bound input schema', async () => {
    const id = 'poll-invented'
    const deps = await freshDeps(id)
    await deps.db.insert(endpoints).values({
      id: `${id}/v1/messages`,
      providerId: id,
      activity: 'chat',
      method: 'POST',
      path: '/v1/messages',
    })
    await deps.db.insert(schemaVersions).values({
      id: `${id}/v1/messages:input`,
      endpointId: `${id}/v1/messages`,
      kind: 'input',
      contentHash: 'a'.repeat(64),
      schema: JSON.stringify({
        properties: { model: { type: 'string' }, messages: { type: 'array' } },
      }),
      derivation: 'upstream-spec',
      createdAt: 1_781_150_000,
    })
    await pollProviderModels(
      deps,
      stubProvider(id, [
        {
          rawId: 'claude-fable-5',
          activity: 'chat',
          schemaEndpointId: 'v1/messages',
          pricing: {
            inputs: {
              quality: { param: 'quality', kind: 'enum', values: ['high'] },
            },
            tables: {},
            price: { lookup: { table: 'rate', keys: ['quality'] } },
            examples: [],
            source: {
              url: 'https://example.com/llms.txt',
              hash: 'a'.repeat(64),
              extractedAt: '2026-09-15T00:00:00Z',
            },
          },
        },
      ]),
    )
    const row = await deps.db.query.models.findFirst({
      where: eq(models.id, modelDbId(id, 'claude-fable-5')),
    })
    expect(row?.pricing).toBeNull()
  })

  it('refuses invented request params on grain=model when a RateCard is listed', async () => {
    const id = 'poll-fal-invented'
    const deps = await freshDeps(id)
    await deps.db.insert(endpoints).values({
      id: `${id}/fal-ai/nano`,
      providerId: id,
      activity: 'image',
      method: 'POST',
      path: '/fal-ai/nano',
    })
    await deps.db.insert(schemaVersions).values({
      id: `${id}/fal-ai/nano:input`,
      endpointId: `${id}/fal-ai/nano`,
      kind: 'input',
      contentHash: 'a'.repeat(64),
      schema: JSON.stringify({
        properties: { prompt: { type: 'string' } },
      }),
      derivation: 'upstream-spec',
      createdAt: 1_781_150_000,
    })
    const provider = stubProvider(id, [
      {
        rawId: 'fal-ai/nano',
        activity: 'image',
        schemaEndpointId: 'fal-ai/nano',
        pricing: {
          inputs: {
            quality: { param: 'quality', kind: 'enum', values: ['high'] },
          },
          tables: {},
          price: { lookup: { table: 'rate', keys: ['quality'] } },
          examples: [],
          source: {
            url: 'https://example.com/llms.txt',
            hash: 'a'.repeat(64),
            extractedAt: '2026-09-15T00:00:00Z',
          },
        },
      },
    ])
    provider.specGrain = 'model'
    await pollProviderModels(deps, provider)
    const row = await deps.db.query.models.findFirst({
      where: eq(models.id, modelDbId(id, 'fal-ai/nano')),
    })
    expect(row?.pricing).toBeNull()
  })

  it('keeps a docs-extracted card when the listing is silent', async () => {
    const id = 'poll-keep-extract'
    const deps = await freshDeps(id)
    const card = {
      inputs: {
        num_images: { param: 'num_images', kind: 'number', default: 1 },
      },
      tables: {},
      price: { '*': [{ var: 'num_images' }, 0.08] },
      examples: [
        {
          params: {},
          usd: 0.08,
          quote: 'Your request will cost $0.08 per image',
        },
      ],
      source: {
        url: 'https://fal.ai/models/fal-ai/nano/llms.txt',
        hash: 'a'.repeat(64),
        extractedAt: '2026-09-15T00:00:00.000Z',
      },
    }
    const listed = stubProvider(id, [
      { rawId: 'fal-ai/nano', activity: 'image' },
    ])
    listed.specGrain = 'model'
    await pollProviderModels(deps, listed)
    await deps.db
      .update(models)
      .set({
        pricing: card,
        factSources: {
          pricing: {
            derivation: 'docs-extracted',
            sourceUrl: card.source.url,
            sourceHash: card.source.hash,
          },
        },
      })
      .where(eq(models.id, modelDbId(id, 'fal-ai/nano')))
    expect(await pollProviderModels(deps, listed)).toMatchObject({
      added: 0,
      updated: 0,
    })
    const kept = await deps.db.query.models.findFirst({
      where: eq(models.id, modelDbId(id, 'fal-ai/nano')),
    })
    expect(kept?.pricing).toMatchObject({
      inputs: { num_images: { param: 'num_images' } },
    })
    expect(
      (kept?.factSources as { pricing?: { derivation: string } }).pricing
        ?.derivation,
    ).toBe('docs-extracted')

    const replaced = await pollProviderModels(
      deps,
      stubProvider(id, [
        {
          rawId: 'fal-ai/nano',
          activity: 'image',
          pricing: { prompt: '0.0000025', completion: '0.00001' },
        },
      ]),
    )
    expect(replaced).toMatchObject({ added: 0, updated: 1 })
    const after = await deps.db.query.models.findFirst({
      where: eq(models.id, modelDbId(id, 'fal-ai/nano')),
    })
    expect(
      (after?.factSources as { pricing?: { derivation: string } }).pricing
        ?.derivation,
    ).toBe('listing')
  })

  it('drops a models.dev card and keeps a provider card', async () => {
    const id = 'poll-models-dev-card'
    const deps = await freshDeps(id)
    const listed = stubProvider(id, [
      { rawId: 'codex-mini' },
      { rawId: 'gpt-4o' },
    ])
    await pollProviderModels(deps, listed)
    const devCard = {
      inputs: {
        num_images: { param: 'num_images', kind: 'number', default: 1 },
      },
      tables: {},
      price: { '*': [{ var: 'num_images' }, 0.08] },
      examples: [],
      source: {
        url: MODELS_DEV_API_URL,
        hash: 'b'.repeat(64),
        extractedAt: '2026-10-04T09:33:23.902Z',
      },
    }
    const openaiCard = {
      ...devCard,
      source: {
        ...devCard.source,
        url: 'https://developers.openai.com/api/docs/pricing',
      },
    }
    await deps.db
      .update(models)
      .set({
        pricing: devCard,
        factSources: {
          contextWindow: { derivation: 'listing' },
          pricing: { derivation: 'listing' },
        },
      })
      .where(eq(models.id, modelDbId(id, 'codex-mini')))
    await deps.db
      .update(models)
      .set({
        pricing: openaiCard,
        factSources: {
          pricing: {
            derivation: 'listing',
            sourceUrl: openaiCard.source.url,
          },
        },
      })
      .where(eq(models.id, modelDbId(id, 'gpt-4o')))

    expect(await pollProviderModels(deps, listed)).toMatchObject({
      added: 0,
      removed: 0,
    })
    const dropped = await deps.db.query.models.findFirst({
      where: eq(models.id, modelDbId(id, 'codex-mini')),
    })
    expect(dropped?.pricing).toBeNull()
    expect(dropped?.deprecatedAt).toBeNull()
    expect(dropped?.factSources).toEqual({
      contextWindow: { derivation: 'listing' },
    })
    const kept = await deps.db.query.models.findFirst({
      where: eq(models.id, modelDbId(id, 'gpt-4o')),
    })
    expect(kept?.pricing).toMatchObject({
      source: { url: 'https://developers.openai.com/api/docs/pricing' },
    })
  })
})

describe('models.dev residue on skip (issue #197)', () => {
  function skipping(id: string): ProviderConfig {
    return {
      ...stubProvider(id, []),
      listModels: () =>
        Promise.resolve({
          models: [],
          skipped: `${id}: no first-party source yet — skipped`,
        }),
    }
  }

  it('deprecates a frozen models.dev catalog once, then leaves a later row', async () => {
    const id = 'poll-models-dev-skip'
    const deps = await freshDeps(id)
    const devCard = {
      inputs: {
        num_images: { param: 'num_images', kind: 'number', default: 1 },
      },
      tables: {},
      price: { '*': [{ var: 'num_images' }, 0.08] },
      examples: [],
      source: {
        url: MODELS_DEV_API_URL,
        hash: 'c'.repeat(64),
        extractedAt: '2026-10-04T09:38:05.665Z',
      },
    }
    await deps.db.insert(models).values([
      {
        id: modelDbId(id, 'muse-spark-1.1'),
        providerId: id,
        rawId: 'muse-spark-1.1',
        activity: 'chat',
        displayName: 'Muse Spark 1.1',
        pricing: devCard,
        factSources: { pricing: { derivation: 'listing' } },
        firstSeenAt: 1,
        lastSeenAt: 1,
      },
      {
        id: modelDbId(id, 'muse-unpriced'),
        providerId: id,
        rawId: 'muse-unpriced',
        activity: 'chat',
        firstSeenAt: 1,
        lastSeenAt: 1,
      },
    ])
    await deps.db.insert(endpoints).values({
      id: `${id}/responses`,
      providerId: id,
      activity: 'chat',
      method: 'POST',
      path: '/responses',
    })
    await deps.db.insert(schemaVersions).values([
      {
        id: `${id}/responses:dev`,
        endpointId: `${id}/responses`,
        kind: 'input',
        contentHash: 'd'.repeat(64),
        schema: JSON.stringify({ type: 'object' }),
        sourceUrl: MODELS_DEV_API_URL,
        createdAt: 1,
      },
      {
        id: `${id}/responses:docs`,
        endpointId: `${id}/responses`,
        kind: 'output',
        contentHash: 'e'.repeat(64),
        schema: JSON.stringify({ type: 'object' }),
        sourceUrl: 'https://example.com/docs',
        createdAt: 1,
      },
    ])

    const first = await pollProviderModels(deps, skipping(id))
    expect(first.skipped).toContain(id)
    expect(first.removed).toBe(2)
    const priced = await deps.db.query.models.findFirst({
      where: eq(models.id, modelDbId(id, 'muse-spark-1.1')),
    })
    expect(priced?.pricing).toBeNull()
    expect(priced?.deprecatedAt).not.toBeNull()
    const unpriced = await deps.db.query.models.findFirst({
      where: eq(models.id, modelDbId(id, 'muse-unpriced')),
    })
    expect(unpriced?.deprecatedAt).not.toBeNull()
    const versions = await deps.db
      .select()
      .from(schemaVersions)
      .where(eq(schemaVersions.endpointId, `${id}/responses`))
    expect(versions.map((row) => row.sourceUrl)).toEqual([
      'https://example.com/docs',
    ])

    await deps.db.insert(models).values({
      id: modelDbId(id, 'later-first-party'),
      providerId: id,
      rawId: 'later-first-party',
      firstSeenAt: 2,
      lastSeenAt: 2,
    })
    const second = await pollProviderModels(deps, skipping(id))
    expect(second.removed).toBe(0)
    const later = await deps.db.query.models.findFirst({
      where: eq(models.id, modelDbId(id, 'later-first-party')),
    })
    expect(later?.deprecatedAt).toBeNull()
  })
})

describe('perModelSchemaFlags', () => {
  it('keeps the named schema flags off unless the listing states them', async () => {
    const id = 'poll-per-model-flags'
    const deps = await freshDeps(id)
    const db = deps.db
    await db.insert(endpoints).values({
      id: `${id}/v1/agent`,
      providerId: id,
      activity: 'chat',
      method: 'POST',
      path: '/v1/agent',
    })
    await db.insert(schemaVersions).values({
      id: `${id}/v1/agent:input`,
      endpointId: `${id}/v1/agent`,
      kind: 'input',
      contentHash: 'b'.repeat(64),
      schema: JSON.stringify({
        properties: {
          tools: { type: 'array' },
          temperature: { type: 'number' },
          reasoning: { type: 'object' },
        },
      }),
      derivation: 'upstream-spec',
      sourceUrl: 'https://example.com/openapi.json',
      createdAt: 1_781_150_000,
    })
    await pollProviderModels(deps, {
      ...stubProvider(id, [
        { rawId: 'plain', activity: 'chat', schemaEndpointId: 'v1/agent' },
        {
          rawId: 'thinker',
          activity: 'chat',
          schemaEndpointId: 'v1/agent',
          capabilities: ['reasoning'],
        },
      ]),
      perModelSchemaFlags: ['reasoning', 'tools'],
    })
    const plain = await db
      .select()
      .from(models)
      .where(eq(models.id, modelDbId(id, 'plain')))
    expect(plain[0]?.capabilities).toEqual(['temperature'])
    expect(
      Object.keys(
        (plain[0]?.factSources as { capabilities: object }).capabilities,
      ),
    ).toEqual(['temperature'])
    const thinker = await db
      .select()
      .from(models)
      .where(eq(models.id, modelDbId(id, 'thinker')))
    expect(thinker[0]?.capabilities).toEqual(['reasoning', 'temperature'])
  })
})

describe('reasoning and server tools (issue #77)', () => {
  it('stores both with provenance and emits model.updated on change', async () => {
    const id = 'poll-features'
    const deps = await freshDeps(id)
    const docs = 'https://example.com/tools'
    const listed: ModelInfo = {
      ...fable,
      reasoning: { mode: 'adaptive', mandatory: true, efforts: ['low'] },
      serverTools: ['web_search_20250305', 'bash_20250124'],
      factSources: {
        serverTools: {
          web_search_20250305: { derivation: 'docs-derived', sourceUrl: docs },
        },
      },
    }
    await pollProviderModels(deps, stubProvider(id, [listed]))
    const row = await deps.db.query.models.findFirst({
      where: eq(models.id, modelDbId(id, fable.rawId)),
    })
    expect(row?.reasoning).toEqual(listed.reasoning)
    expect(row?.serverTools).toEqual(listed.serverTools)
    // Docs-tagged tools keep their source; untagged ones default to listing.
    expect(row?.factSources).toMatchObject({
      reasoning: { derivation: 'listing' },
      serverTools: {
        web_search_20250305: { derivation: 'docs-derived', sourceUrl: docs },
        bash_20250124: { derivation: 'listing' },
      },
    })

    const outcome = await pollProviderModels(
      deps,
      stubProvider(id, [{ ...listed, serverTools: ['bash_20250124'] }]),
    )
    expect(outcome.updated).toBe(1)
  })
})

describe('listed request map', () => {
  it('keeps a map the listing read from the model schema', async () => {
    const id = 'poll-listed-request-map'
    const deps = await freshDeps(id)
    const requestMap = {
      thinking: null,
      maxTokensField: 'max_completion_tokens' as const,
      developerRole: null,
      replayReasoningContent: null,
      store: null,
      strictTools: null,
      sessionAffinity: null,
      cacheControl: null,
      toolStream: null,
      reasoningEffort: true,
    }
    const provider = stubProvider(id, [{ ...fable, requestMap }, haiku])
    await pollProviderModels(deps, provider)
    const stored = async (rawId: string) =>
      (
        await deps.db.query.models.findFirst({
          where: eq(models.id, modelDbId(id, rawId)),
        })
      )?.requestMap
    expect(await stored(fable.rawId)).toEqual(requestMap)
    // No listed map and no provider-wide case: still null.
    expect(await stored(haiku.rawId)).toBeNull()
    expect((await pollProviderModels(deps, provider)).updated).toBe(0)
  })
})

/** One poll in its own scope, with the ingest events it noted. */
async function pollWithEvents(deps: SyncDeps, provider: ProviderConfig) {
  return runIngestScope(async () => {
    const outcome = await pollProviderModels(deps, provider)
    return { outcome, events: takeIngestEvents() }
  })
}

async function storedRow(deps: SyncDeps, providerId: string, rawId: string) {
  const row = await deps.db.query.models.findFirst({
    where: eq(models.id, modelDbId(providerId, rawId)),
  })
  if (!row) throw new Error(`no row for ${rawId}`)
  return row
}

async function changesFor(deps: SyncDeps, providerId: string) {
  const rows = await deps.db
    .select()
    .from(changes)
    .where(eq(changes.providerId, providerId))
  return rows.length
}

describe('absent facts (FactAbsence)', () => {
  const listing = { prompt: '0.0000025', completion: '0.00001' }

  it('keeps a card the listing omits and drops one it clears', async () => {
    const id = 'poll-absent-cleared'
    const deps = await freshDeps(id)
    const row: ModelInfo = { rawId: 'm', activity: 'chat', contextWindow: 8192 }
    await pollProviderModels(
      deps,
      stubProvider(id, [{ ...row, pricing: listing }]),
    )
    const before = await changesFor(deps, id)

    // Omitted: could be a parser miss, so the card stays and it is logged.
    const omitted = await pollWithEvents(deps, stubProvider(id, [row]))
    expect(omitted.outcome).toMatchObject({ updated: 0, failures: 1 })
    expect(omitted.events).toEqual([
      {
        event: 'pricing_lost',
        properties: { providerId: id, rawId: 'm', reason: 'parser_miss' },
      },
    ])
    expect((await storedRow(deps, id, 'm')).pricing).not.toBeNull()
    expect(await changesFor(deps, id)).toBe(before)

    // Cleared: the source says there is no price. One change, no failure.
    const cleared = stubProvider(id, [
      { ...row, absent: { pricing: 'cleared' } },
    ])
    const first = await pollWithEvents(deps, cleared)
    expect(first.outcome).toMatchObject({ updated: 1, failures: 0 })
    expect(first.events).toEqual([])
    const after = await storedRow(deps, id, 'm')
    expect(after.pricing).toBeNull()
    expect(after.contextWindow).toBe(8192)
    expect(after.factSources).toEqual({
      contextWindow: { derivation: 'listing' },
    })
    expect(await changesFor(deps, id)).toBe(before + 1)

    const again = await pollWithEvents(deps, cleared)
    expect(again.outcome).toMatchObject({ updated: 0, failures: 0 })
    expect(again.events).toEqual([])
  })

  it('writes null for any other fact, omitted or cleared alike', async () => {
    const id = 'poll-absent-other'
    const deps = await freshDeps(id)
    const full: ModelInfo = {
      rawId: 'm',
      activity: 'chat',
      contextWindow: 8192,
      maxOutput: 4096,
    }
    await pollProviderModels(deps, stubProvider(id, [full]))
    const { outcome, events } = await pollWithEvents(
      deps,
      stubProvider(id, [
        { rawId: 'm', activity: 'chat', absent: { maxOutput: 'cleared' } },
      ]),
    )
    expect(outcome).toMatchObject({ updated: 1, failures: 0 })
    expect(events).toEqual([])
    expect(await storedRow(deps, id, 'm')).toMatchObject({
      contextWindow: null,
      maxOutput: null,
      factSources: null,
    })
  })
})

describe('docs failures (tryDocs)', () => {
  const DOC = 'https://docs.example.com/models.md'
  const docsSource = (path: string) => ({
    derivation: 'docs-derived' as const,
    sourceUrl: DOC,
    sourceHash: 'h1',
    path,
  })
  const docsFacts: Partial<ModelInfo> = {
    contextWindow: 200_000,
    capabilities: ['tools', 'reasoning'],
    reasoning: { mode: 'effort', mandatory: false, efforts: ['low', 'high'] },
    schemaEndpointId: 'v1/chat',
    factSources: {
      contextWindow: docsSource('contextWindow'),
      capabilities: {
        tools: docsSource('capabilities.tools'),
        reasoning: docsSource('capabilities.reasoning'),
      },
      reasoning: docsSource('reasoning'),
    },
  }
  type State = { price: string; docs: 'ok' | 'down'; listing: 'ok' | 'down' }

  /** An adapter shaped like the converted ones: listing, then one docs page. */
  function docsProvider(id: string, state: State): ProviderConfig {
    return {
      ...stubProvider(id, []),
      listModels: async () => {
        if (state.listing === 'down') throw new Error('listing 503')
        const docsFailures: Array<DocsFailure> = []
        const facts = await tryDocs(docsFailures, DOC, () =>
          state.docs === 'ok'
            ? Promise.resolve(docsFacts)
            : Promise.reject(new Error('page changed shape')),
        )
        return {
          models: ['a', 'b'].map((rawId) => ({
            rawId,
            activity: 'chat' as const,
            pricing: { prompt: state.price, completion: '0.00001' },
            ...(facts ??
              unavailable(
                'contextWindow',
                'capabilities',
                'reasoning',
                'schemaEndpointId',
              )),
          })),
          docsFailures,
        }
      },
    }
  }

  it('keeps stored docs facts, lets a price update through, and stays visible', async () => {
    const id = 'poll-docs-down'
    const deps = await freshDeps(id)
    const state: State = { price: '0.000001', docs: 'ok', listing: 'ok' }
    const provider = docsProvider(id, state)
    expect(await pollProviderModels(deps, provider)).toMatchObject({
      added: 2,
      failures: 0,
    })
    const good = await storedRow(deps, id, 'a')
    expect(good).toMatchObject({
      contextWindow: 200_000,
      capabilities: ['tools', 'reasoning'],
      schemaEndpointId: 'v1/chat',
    })
    const facts = (row: typeof good) => ({
      contextWindow: row.contextWindow,
      capabilities: row.capabilities,
      reasoning: row.reasoning,
      requestMap: row.requestMap,
      schemaEndpointId: row.schemaEndpointId,
      factSources: {
        ...(row.factSources as Record<string, unknown>),
        pricing: null,
      },
    })

    // Docs down, nothing else moved: no row is written, no change fans out.
    state.docs = 'down'
    const before = await changesFor(deps, id)
    const quiet = await pollWithEvents(deps, provider)
    expect(quiet.outcome).toMatchObject({
      updated: 0,
      failures: 1,
      docsFailures: [{ source: DOC, error: 'page changed shape' }],
    })
    expect(quiet.events).toEqual([
      {
        event: 'ingest_failed',
        properties: {
          job: 'models-poll',
          providerId: id,
          source: DOC,
          error: 'page changed shape',
        },
      },
    ])
    expect(await changesFor(deps, id)).toBe(before)
    expect(facts(await storedRow(deps, id, 'a'))).toEqual(facts(good))

    // Docs still down and the listing reprices: the price lands, the docs
    // facts and their provenance stay exactly as stored.
    state.price = '0.000002'
    const repriced = await pollWithEvents(deps, provider)
    expect(repriced.outcome).toMatchObject({ updated: 2, failures: 1 })
    expect(repriced.events).toHaveLength(1)
    const kept = await storedRow(deps, id, 'a')
    expect(facts(kept)).toEqual(facts(good))
    expect(kept.pricing).not.toEqual(good.pricing)
    expect(kept.pricing).toMatchObject({
      tables: { rate: { base: { input_tokens: 0.000002 } } },
    })

    // Docs back: nothing to repair, and the failure is gone.
    state.docs = 'ok'
    const back = await pollWithEvents(deps, provider)
    expect(back.outcome).toMatchObject({ updated: 0, failures: 0 })
    expect(back.outcome.docsFailures).toBeUndefined()
    expect(back.events).toEqual([])
  })

  it('keeps a docs-sourced price too, without calling it lost', async () => {
    const id = 'poll-docs-down-price'
    const deps = await freshDeps(id)
    const priced = stubProvider(id, [
      {
        rawId: 'm',
        activity: 'chat',
        pricing: { prompt: '0.000001', completion: '0.00001' },
      },
    ])
    await pollProviderModels(deps, priced)
    const good = await storedRow(deps, id, 'm')
    const { outcome, events } = await pollWithEvents(deps, {
      ...priced,
      listModels: () =>
        Promise.resolve({
          models: [{ rawId: 'm', activity: 'chat', ...unavailable('pricing') }],
          docsFailures: [{ source: DOC, error: '404', elapsedMs: 3 }],
        }),
    })
    expect(outcome).toMatchObject({ updated: 0, failures: 1 })
    expect(events.map((event) => event.event)).toEqual(['ingest_failed'])
    const kept = await storedRow(deps, id, 'm')
    expect(kept.pricing).toEqual(good.pricing)
    expect(kept.factSources).toEqual(good.factSources)
  })

  it('still fails the whole poll when the listing fails', async () => {
    const id = 'poll-listing-down'
    const deps = await freshDeps(id)
    const state: State = { price: '0.000001', docs: 'ok', listing: 'ok' }
    const provider = docsProvider(id, state)
    await pollProviderModels(deps, provider)
    const before = await storedRow(deps, id, 'a')

    state.listing = 'down'
    state.price = '0.000009'
    await expect(pollProviderModels(deps, provider)).rejects.toThrow(
      'listing 503',
    )
    const [outcome] = await pollAllProviders(deps, [provider])
    expect(outcome).toMatchObject({
      providerId: id,
      error: 'listing 503',
      failures: 1,
      updated: 0,
    })
    expect(await storedRow(deps, id, 'a')).toEqual(before)
  })

  it('tries every fast-failing page but stops once failures have cost the budget', async () => {
    const failures: Array<DocsFailure> = []
    let loads = 0
    const load = () => {
      loads++
      return Promise.reject(new Error('down'))
    }
    for (let i = 0; i < 6; i++) await tryDocs(failures, DOC, load)
    expect(loads).toBe(6)
    expect(failures).toHaveLength(6)

    // One load that hung to its timeout: the rest are not attempted.
    failures.push({ source: DOC, error: 'timeout', elapsedMs: 60_000 })
    expect(await tryDocs(failures, DOC, load)).toBeNull()
    expect(loads).toBe(6)
    expect(failures).toHaveLength(7)
  })
})

describe('Hugging Face prices follow provider agreement', () => {
  const route = (name: string, input: number) => ({
    provider: name,
    status: 'live',
    context_length: 8192,
    pricing: { input, output: 0.2 },
    supports_tools: true,
    supports_structured_output: false,
  })
  const payload = (list: Array<unknown>) => ({
    data: [
      {
        id: 'org/model',
        created: 1_785_918_179,
        architecture: {
          input_modalities: ['text'],
          output_modalities: ['text'],
        },
        providers: list,
      },
    ],
  })

  it('settled → unsettled → settled: card, cleared, card', async () => {
    const id = 'poll-hf-flip'
    const deps = await freshDeps(id)
    let hosts: Array<unknown> = [route('nscale', 0.07)]
    const provider: ProviderConfig = {
      ...stubProvider(id, []),
      listModels: async () => ({
        models: await parseHuggingFaceModels(payload(hosts)),
      }),
    }
    const inputRate = async () => {
      const card = (await storedRow(deps, id, 'org/model')).pricing as {
        tables: { rate: { base: { input_tokens: number } } }
      } | null
      return card?.tables.rate.base.input_tokens ?? null
    }

    expect((await pollWithEvents(deps, provider)).outcome).toMatchObject({
      added: 1,
      failures: 0,
    })
    expect(await inputRate()).toBe(0.07 / 1e6)

    // A second host joins at another price: no single price holds.
    hosts = [route('nscale', 0.07), route('novita', 0.09)]
    const unsettled = await pollWithEvents(deps, provider)
    expect(unsettled.outcome).toMatchObject({ updated: 1, failures: 0 })
    expect(unsettled.events).toEqual([])
    const row = await storedRow(deps, id, 'org/model')
    expect(row.pricing).toBeNull()
    expect(row.contextWindow).toBe(8192)
    expect(row.factSources).not.toHaveProperty('pricing')
    const quiet = await pollWithEvents(deps, provider)
    expect(quiet.outcome).toMatchObject({ updated: 0, failures: 0 })

    // They agree again, at the new price.
    hosts = [route('nscale', 0.09), route('novita', 0.09)]
    const settled = await pollWithEvents(deps, provider)
    expect(settled.outcome).toMatchObject({ updated: 1, failures: 0 })
    expect(await inputRate()).toBe(0.09 / 1e6)
    expect((await pollWithEvents(deps, provider)).outcome).toMatchObject({
      updated: 0,
      failures: 0,
    })
  })
})
