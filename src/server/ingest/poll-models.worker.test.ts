import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'

import { getDb } from '../../db/index.ts'
import { changes, models, providers } from '../../db/schema.ts'
import type { ModelInfo, ProviderConfig } from '../providers/types.ts'
import { modelDbId, pollProviderModels } from './poll-models.ts'
import type { SyncDeps } from './sync.ts'

function stubProvider(id: string, list: Array<ModelInfo>): ProviderConfig {
  return {
    id,
    displayName: 'Stub',
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
})
