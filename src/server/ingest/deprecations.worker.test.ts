import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'

import { getDb } from '../../db/index.ts'
import { changes, models, providers } from '../../db/schema.ts'
import type {
  ListModelsResult,
  ModelDeprecation,
  ModelInfo,
  ProviderConfig,
} from '../providers/types.ts'
import { modelDbId, pollProviderModels } from './poll-models.ts'
import type { SyncDeps } from './sync.ts'

function stub(id: string, next: () => ListModelsResult): ProviderConfig {
  return {
    id,
    displayName: 'Stub',
    defaultDerivation: 'upstream-spec',
    fetchSpec: () =>
      Promise.resolve({ specs: [], sources: [], outputStrategy: 'post-200' }),
    listModels: () => Promise.resolve(next()),
    classify: () => null,
  }
}

async function deps(providerId: string): Promise<SyncDeps> {
  const db = getDb(env)
  await db.insert(providers).values({
    id: providerId,
    displayName: 'Stub',
    specSourceUrl: 'https://example.com/spec.json',
  })
  let tick = 1_790_000_000
  return { db, kv: env.SCHEMA_CACHE, secrets: {}, now: () => tick++ }
}

const live: ModelInfo = { rawId: 'live-1', activity: 'chat' }
const old: ModelInfo = { rawId: 'old-1', activity: 'chat' }
const entry = (rawId: string): ModelDeprecation => ({
  rawId,
  deprecatedAt: 1_780_000_000,
  retiresAt: 1_786_000_000,
  replacedBy: ['live-1'],
  sourceUrl: 'https://example.com/deprecations',
})

describe('deprecations page in the models poll (issue #410)', () => {
  it('deprecates listed and unlisted rows, adds never-seen ids, keeps them when the page fails', async () => {
    const p = 'dep-stub'
    const d = await deps(p)
    let result: ListModelsResult = { models: [live, old] }
    const provider = stub(p, () => result)
    await pollProviderModels(d, provider)

    result = {
      models: [live, old],
      deprecations: [entry('old-1'), entry('gone-1')],
    }
    await pollProviderModels(d, provider)
    const row = async (rawId: string) =>
      (
        await d.db
          .select()
          .from(models)
          .where(eq(models.id, modelDbId(p, rawId)))
      )[0]
    expect((await row('live-1'))?.deprecatedAt).toBeNull()
    expect(await row('old-1')).toEqual(
      expect.objectContaining({
        deprecatedAt: 1_780_000_000,
        deprecation: entry('old-1'),
      }),
    )
    expect(await row('gone-1')).toEqual(
      expect.objectContaining({
        activity: null,
        deprecatedAt: 1_780_000_000,
        deprecation: entry('gone-1'),
      }),
    )
    const feed = await d.db
      .select()
      .from(changes)
      .where(eq(changes.type, 'model.deprecated'))
    expect(feed.map((c) => c.subjectId).sort()).toEqual([
      modelDbId(p, 'gone-1'),
      modelDbId(p, 'old-1'),
    ])

    // Page failed: no deprecations. Nothing flips back, no new events.
    result = { models: [live, old] }
    const outcome = await pollProviderModels(d, provider)
    expect(outcome.updated).toBe(0)
    expect((await row('old-1'))?.deprecation).toEqual(entry('old-1'))
    expect((await row('gone-1'))?.deprecatedAt).toBe(1_780_000_000)

    // Same page again: no new events.
    result = {
      models: [live, old],
      deprecations: [entry('old-1'), entry('gone-1')],
    }
    await pollProviderModels(d, provider)
    const again = await d.db
      .select()
      .from(changes)
      .where(eq(changes.type, 'model.deprecated'))
    expect(again).toHaveLength(2)

    // The listed row leaves the page: it is live again.
    result = { models: [live, old], deprecations: [entry('gone-1')] }
    await pollProviderModels(d, provider)
    expect(await row('old-1')).toEqual(
      expect.objectContaining({ deprecatedAt: null, deprecation: null }),
    )
  })
})
