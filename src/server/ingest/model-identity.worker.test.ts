import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'
import { and, eq } from 'drizzle-orm'

import { getDb } from '#/db/index.ts'
import { changes, models } from '#/db/schema.ts'
import { getModelDetail } from '#/server/catalog.ts'
import { anthropicProvider } from '#/server/providers/anthropic.ts'
import { geminiProvider } from '#/server/providers/gemini.ts'
import { openaiProvider } from '#/server/providers/openai.ts'
import { openrouterProvider } from '#/server/providers/openrouter.ts'
import { provider as vercel } from '#/server/providers/adapters/vercel.ts'
import { provider as azure } from '#/server/providers/adapters/azure.ts'
import { namespacedUpstreamIdentity } from '#/server/providers/upstream-model.ts'
import type { ModelInfo, ProviderConfig } from '#/server/providers/types.ts'
import { GPT_4O } from '../../../packages/rate-card/src/fixtures/gpt-4o.ts'
import {
  modelDbId,
  pollAllProviders,
  pollProviderModels,
} from './poll-models.ts'
import type { SyncDeps } from './sync.ts'
import { reconcileSameAs } from './model-identity.ts'

const SOURCE = {
  derivation: 'listing' as const,
  sourceUrl: 'https://example.com/models',
  path: 'data[].id',
}
const NOW = 1_781_150_100

function deps(): SyncDeps {
  let now = 1_781_150_000
  return { db: getDb(env), kv: env.SCHEMA_CACHE, secrets: {}, now: () => now++ }
}

function stub(
  id: string,
  listed: Array<ModelInfo>,
  extra: Partial<ProviderConfig> = {},
): ProviderConfig {
  return {
    id,
    displayName: id,
    specSourceUrl: `https://example.com/${id}`,
    defaultDerivation: 'upstream-spec',
    fetchSpec: async () => ({
      specs: [],
      sources: [],
      outputStrategy: 'post-200',
    }),
    listModels: async () => ({ models: listed }),
    classify: () => null,
    ...extra,
  }
}

const identify = (rawId: string) => namespacedUpstreamIdentity(rawId, SOURCE)
const gateway = { upstreamModelIdentity: identify }

function linkChanges(d: SyncDeps, subjectId: string) {
  return d.db
    .select()
    .from(changes)
    .where(
      and(
        eq(changes.subjectId, subjectId),
        eq(changes.summary, 'Upstream model link updated'),
      ),
    )
}

describe('sameAs links', () => {
  it('links when the upstream arrives later, without touching the row or repeating the event', async () => {
    const d = deps()
    const makerId = 'identity-new-maker'
    const resellerId = 'identity-new-reseller'
    const rawId = 'publisher/native-alias'
    const rowId = modelDbId(resellerId, rawId)
    const row = () =>
      d.db.query.models.findFirst({ where: eq(models.id, rowId) })
    const reseller = stub(resellerId, [{ rawId, contextWindow: 1234 }], gateway)
    await pollProviderModels(d, reseller)
    await reconcileSameAs(d.db, NOW)
    const before = await row()
    expect(before).toMatchObject({
      upstreamProvider: 'publisher',
      upstreamRawId: 'native-alias',
      upstreamSource: SOURCE,
      sameAsModelId: null,
    })
    const unresolved = await getModelDetail(d.db, resellerId, rawId)
    expect(unresolved?.sameAs).toBeNull()
    expect(unresolved?.factSources).not.toHaveProperty('sameAs')

    const native = {
      rawId: 'native-dated',
      aliases: ['native-alias'],
      pricing: GPT_4O,
      contextWindow: 200_000,
    }
    const claim = { modelNamespaces: ['publisher'] }
    await pollProviderModels(d, stub(makerId, [native], claim))
    await reconcileSameAs(d.db, NOW)
    const targetId = modelDbId(makerId, native.rawId)
    // The link is the only thing that changes on the reseller's row.
    expect(await row()).toEqual({ ...before, sameAsModelId: targetId })
    const linked = await getModelDetail(d.db, resellerId, rawId)
    expect(linked?.sameAs).toEqual({ provider: makerId, rawId: native.rawId })
    expect(linked?.pricing).toBeNull()
    expect(linked?.contextWindow).toBe(1234)
    expect(linked?.factSources?.sameAs).toEqual(SOURCE)
    const [event, ...extra] = await linkChanges(d, rowId)
    expect(extra).toHaveLength(0)
    expect(event).toMatchObject({
      type: 'model.updated',
      providerId: resellerId,
      payload: {
        before: { sameAsModelId: null },
        after: { sameAsModelId: targetId },
      },
    })

    expect((await pollProviderModels(d, reseller)).updated).toBe(0)
    await reconcileSameAs(d.db, NOW)
    // A delisted upstream is deprecated, not deleted: the row still exists.
    await pollProviderModels(d, stub(makerId, [], claim))
    await reconcileSameAs(d.db, NOW)
    expect((await row())?.sameAsModelId).toBe(targetId)
    expect(await linkChanges(d, rowId)).toHaveLength(1)

    // The provider stops stating an upstream: evidence and link both go.
    await pollProviderModels(
      d,
      stub(resellerId, [{ rawId, contextWindow: 1234 }]),
    )
    await reconcileSameAs(d.db, NOW)
    expect(await row()).toMatchObject({
      upstreamProvider: null,
      upstreamRawId: null,
      upstreamSource: null,
      sameAsModelId: null,
    })
    expect(await linkChanges(d, rowId)).toHaveLength(2)
  })

  it('resolves namespaces through the database and prefers exact ids, then aliases, then dots as hyphens', async () => {
    const d = deps()
    await pollProviderModels(
      d,
      stub(
        'identity-a',
        [
          { rawId: 'model', aliases: ['ambiguous'] },
          { rawId: 'other', aliases: ['ambiguous', 'model'] },
          { rawId: 'model-x' },
          { rawId: 'v-4-5-dated', aliases: ['v-4-5'] },
          { rawId: 'v.1' },
          { rawId: 'v-1' },
          { rawId: 'dup-a', aliases: ['dup-1'] },
          { rawId: 'dup-b', aliases: ['dup-1'] },
        ],
        { modelNamespaces: ['shared-publisher'] },
      ),
    )
    // A second claimant makes the namespace ambiguous; a provider id still
    // beats a namespace of the same name.
    const rival = (modelNamespaces: Array<string>) =>
      pollProviderModels(
        d,
        stub('identity-b', [{ rawId: 'model' }], { modelNamespaces }),
      )
    await rival(['shared-publisher', 'identity-a'])
    const host = 'identity-host'
    await pollProviderModels(
      d,
      stub(
        host,
        [
          'identity-a/model',
          'identity-a/ambiguous',
          'identity-a/MODEL-X',
          'identity-a/model:free',
          'identity-a/v-4.5',
          'identity-a/v.1',
          'identity-a/dup.1',
          'identity-unlisted/model',
          'shared-publisher/model',
        ].map((rawId) => ({ rawId })),
        gateway,
      ),
    )
    // A row whose own alias matches its stated upstream must not self-link.
    await pollProviderModels(
      d,
      stub(
        'identity-self',
        [{ rawId: 'identity-self/m', aliases: ['m'] }],
        gateway,
      ),
    )
    // No stated upstream: a matching name alone is not evidence.
    await pollProviderModels(
      d,
      stub('identity-unproven-host', [{ rawId: 'identity-a/model' }]),
    )
    await reconcileSameAs(d.db, NOW)

    const detail = (provider: string, rawId: string) =>
      getModelDetail(d.db, provider, rawId)
    for (const [rawId, target] of [
      ['identity-a/model', 'model'],
      ['identity-a/v.1', 'v.1'],
    ] as const) {
      const exact = await detail(host, rawId)
      expect(exact?.sameAs).toEqual({ provider: 'identity-a', rawId: target })
      expect(exact?.factSources?.sameAs).toEqual(SOURCE)
    }
    const normalized = await detail(host, 'identity-a/v-4.5')
    expect(normalized?.sameAs).toEqual({
      provider: 'identity-a',
      rawId: 'v-4-5-dated',
    })
    expect(normalized?.factSources?.sameAs).toEqual({
      ...SOURCE,
      normalized: true,
    })
    for (const rawId of [
      'identity-a/ambiguous',
      'identity-a/MODEL-X',
      'identity-a/model:free',
      'identity-a/dup.1',
      'identity-unlisted/model',
      'shared-publisher/model',
    ]) {
      expect((await detail(host, rawId))?.sameAs).toBeNull()
    }
    expect(
      (await detail('identity-self', 'identity-self/m'))?.sameAs,
    ).toBeNull()
    expect(
      (await detail('identity-unproven-host', 'identity-a/model'))?.sameAs,
    ).toBeNull()

    // Dropping the rival claim from config removes its row, so the namespace
    // resolves again.
    await rival([])
    await reconcileSameAs(d.db, NOW)
    expect((await detail(host, 'shared-publisher/model'))?.sameAs).toEqual({
      provider: 'identity-a',
      rawId: 'model',
    })
  })

  it('writes every link when one run changes more than a batch', async () => {
    const d = deps()
    const ids = Array.from({ length: 12 }, (_, i) => `m${i}`)
    await pollProviderModels(
      d,
      stub(
        'identity-bulk-maker',
        ids.map((rawId) => ({ rawId })),
      ),
    )
    await pollProviderModels(
      d,
      stub(
        'identity-bulk-host',
        ids.map((id) => ({ rawId: `identity-bulk-maker/${id}` })),
        gateway,
      ),
    )
    await reconcileSameAs(d.db, NOW)
    const rows = await d.db
      .select()
      .from(models)
      .where(eq(models.providerId, 'identity-bulk-host'))
    expect(rows.filter((row) => row.sameAsModelId !== null)).toHaveLength(12)
    expect(
      await d.db
        .select()
        .from(changes)
        .where(eq(changes.providerId, 'identity-bulk-host')),
    ).toHaveLength(12 * 2) // model.added + the link
  })

  it('resolves links at the end of a poll run, whatever order providers poll in', async () => {
    const d = deps()
    const outcomes = await pollAllProviders(d, [
      stub('identity-run-host', [{ rawId: 'identity-run-maker/m' }], gateway),
      stub('identity-run-maker', [{ rawId: 'm' }]),
    ])
    expect(outcomes.map((outcome) => outcome.failures)).toEqual([0, 0])
    const rowId = modelDbId('identity-run-host', 'identity-run-maker/m')
    const row = await d.db.query.models.findFirst({
      where: eq(models.id, rowId),
    })
    expect(row?.sameAsModelId).toBe(modelDbId('identity-run-maker', 'm'))
    expect(await linkChanges(d, rowId)).toHaveLength(1)
  })

  it("keeps a failed reconcile out of the providers' poll outcomes", async () => {
    // The clock is read once per provider poll, then once by the reconcile
    // step, so failing the second read fails only the reconcile.
    let reads = 0
    const d: SyncDeps = {
      ...deps(),
      now: () => {
        if (++reads > 1) throw new Error('reconcile failed')
        return NOW
      },
    }
    const outcomes = await pollAllProviders(d, [
      stub('identity-run-solo', [{ rawId: 'm' }]),
    ])
    expect(outcomes).toMatchObject([{ failures: 0, added: 1 }])
  })

  it('enforces the target foreign key and rejects a self link', async () => {
    const d = deps()
    await pollProviderModels(d, stub('identity-fk', [{ rawId: 'model' }]))
    const id = modelDbId('identity-fk', 'model')
    await expect(
      d.db
        .update(models)
        .set({ sameAsModelId: 'does-not-exist' })
        .where(eq(models.id, id)),
    ).rejects.toThrow()
    await expect(
      d.db.update(models).set({ sameAsModelId: id }).where(eq(models.id, id)),
    ).rejects.toThrow()
    await expect(
      d.db
        .update(models)
        .set({ upstreamProvider: 'half-an-identity' })
        .where(eq(models.id, id)),
    ).rejects.toThrow()
  })

  it('links OpenRouter, Vercel, and Azure rows to the upstream they state (#199)', async () => {
    const d = deps()
    const pollFixture = (p: ProviderConfig, listed: Array<ModelInfo>) =>
      pollProviderModels(d, {
        ...p,
        listModels: async () => ({ models: listed }),
      })
    await pollFixture(anthropicProvider, [
      {
        rawId: 'claude-opus-4-5-20251101',
        aliases: ['claude-opus-4-5'],
        pricing: GPT_4O,
      },
      { rawId: 'claude-fable-5' },
    ])
    await pollFixture(openaiProvider, [{ rawId: 'gpt-4o-2024-11-20' }])
    await pollFixture(geminiProvider, [{ rawId: 'gemini-2.5-pro' }])
    // Ids as the gateways publish them: dotted versions, `google` for Gemini.
    await pollFixture(openrouterProvider, [
      { rawId: 'anthropic/claude-opus-4.5', contextWindow: 1234 },
      { rawId: 'anthropic/claude-opus-4.5:batch' },
      { rawId: 'anthropic/claude-fable-5' },
      { rawId: 'claude-opus-4-5' },
      { rawId: 'openai/missing-native-model' },
    ])
    await pollFixture(vercel, [
      { rawId: 'google/gemini-2.5-pro' },
      { rawId: 'anthropic/claude-opus-4.5' },
    ])
    await pollFixture(azure, [{ rawId: 'gpt-4o-2024-11-20' }])
    await reconcileSameAs(d.db, NOW)

    const opus = 'claude-opus-4-5-20251101'
    const cases = [
      ['openrouter', 'anthropic/claude-opus-4.5', 'anthropic', opus, 'listing'],
      [
        'openrouter',
        'anthropic/claude-fable-5',
        'anthropic',
        'claude-fable-5',
        'listing',
      ],
      ['vercel', 'anthropic/claude-opus-4.5', 'anthropic', opus, 'listing'],
      [
        'vercel',
        'google/gemini-2.5-pro',
        'gemini',
        'gemini-2.5-pro',
        'listing',
      ],
      [
        'azure',
        'gpt-4o-2024-11-20',
        'openai',
        'gpt-4o-2024-11-20',
        'docs-derived',
      ],
    ] as const
    for (const [provider, rawId, upstream, nativeId, derivation] of cases) {
      const result = await getModelDetail(d.db, provider, rawId)
      expect(result?.sameAs).toEqual({ provider: upstream, rawId: nativeId })
      expect(result?.factSources?.sameAs?.derivation).toBe(derivation)
      // Only the dotted spelling needed normalizing.
      expect(result?.factSources?.sameAs?.normalized).toBe(
        rawId.endsWith('4.5') ? true : undefined,
      )
    }
    const linked = await getModelDetail(
      d.db,
      'openrouter',
      'anthropic/claude-opus-4.5',
    )
    expect(linked?.contextWindow).toBe(1234)
    expect(linked?.pricing).toBeNull()
    for (const rawId of [
      'anthropic/claude-opus-4.5:batch',
      'claude-opus-4-5',
      'openai/missing-native-model',
    ]) {
      const unlinked = await getModelDetail(d.db, 'openrouter', rawId)
      expect(unlinked?.sameAs).toBeNull()
      expect(unlinked?.factSources?.sameAs).toBeUndefined()
    }
  })
})
