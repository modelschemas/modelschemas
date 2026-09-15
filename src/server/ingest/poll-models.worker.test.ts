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
import type { ModelInfo, ProviderConfig } from '../providers/types.ts'
import { modelDbId, pollProviderModels } from './poll-models.ts'
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
})
