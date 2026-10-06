import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'

import { getDb } from '#/db/index.ts'
import { models, providerModelNamespaces } from '#/db/schema.ts'
import { getModelDetail } from '#/server/catalog.ts'
import { anthropicProvider } from '#/server/providers/anthropic.ts'
import { geminiProvider } from '#/server/providers/gemini.ts'
import { openaiProvider } from '#/server/providers/openai.ts'
import { openrouterProvider } from '#/server/providers/openrouter.ts'
import { provider as vercel } from '#/server/providers/adapters/vercel.ts'
import { provider as azure } from '#/server/providers/adapters/azure.ts'
import { provider as cloudflare } from '#/server/providers/adapters/cloudflare-ai-gateway.ts'
import { provider as workersAi } from '#/server/providers/adapters/cloudflare-workers-ai.ts'
import { namespacedUpstreamIdentity } from '#/server/providers/upstream-model.ts'
import type { ModelInfo, ProviderConfig } from '#/server/providers/types.ts'
import { GPT_4O } from '../../../packages/rate-card/src/fixtures/gpt-4o.ts'
import { modelDbId, pollProviderModels } from './poll-models.ts'
import { ensureProviderRow } from './sync.ts'
import type { SyncDeps } from './sync.ts'
import { persistUpstreamIdentities, reconcileSameAs } from './model-identity.ts'

const SOURCE = {
  derivation: 'listing' as const,
  sourceUrl: 'https://example.com/models',
  path: 'data[].id',
}

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

describe('persisted upstream identity', () => {
  it('keeps a consistent link and provenance while new evidence awaits resolution', async () => {
    const d = deps()
    const makerId = 'identity-snapshot-maker'
    const resellerId = 'identity-snapshot-reseller'
    await pollProviderModels(
      d,
      stub(makerId, [{ rawId: 'first' }, { rawId: 'second' }]),
    )
    await pollProviderModels(
      d,
      stub(resellerId, [
        {
          rawId: 'dealer-id',
          contextWindow: 1234,
          upstreamModelIdentity: {
            providerNamespace: makerId,
            rawId: 'first',
            source: SOURCE,
          },
        },
      ]),
    )
    const nextSource = {
      derivation: 'docs-derived' as const,
      sourceUrl: 'https://example.com/revised-model',
    }
    await persistUpstreamIdentities(d.db, [
      {
        id: modelDbId(resellerId, 'dealer-id'),
        identity: {
          providerNamespace: makerId,
          rawId: 'second',
          source: nextSource,
        },
      },
    ])
    const pending = await getModelDetail(d.db, resellerId, 'dealer-id')
    expect(pending?.sameAs).toEqual({ provider: makerId, rawId: 'first' })
    expect(pending?.factSources?.sameAs).toEqual(SOURCE)
    await reconcileSameAs(d.db, 1_781_150_100)
    const resolved = await getModelDetail(d.db, resellerId, 'dealer-id')
    expect(resolved?.sameAs).toEqual({ provider: makerId, rawId: 'second' })
    expect(resolved?.factSources?.sameAs).toEqual(nextSource)
    expect(resolved?.contextWindow).toBe(1234)
  })

  it('resolves new providers through database identities when the maker arrives later', async () => {
    const d = deps()
    const makerId = 'identity-new-maker'
    const resellerId = 'identity-new-reseller'
    const rawId = 'publisher/native-alias'
    const reseller = stub(resellerId, [{ rawId, contextWindow: 1234 }], {
      upstreamModelIdentity: identify,
    })
    await pollProviderModels(d, reseller)
    const before = await d.db.query.models.findFirst({
      where: eq(models.id, modelDbId(resellerId, rawId)),
    })
    expect(before).toMatchObject({
      upstreamProvider: 'publisher',
      upstreamRawId: 'native-alias',
      sameAsModelId: null,
    })
    expect(before?.upstreamSource).toEqual(SOURCE)
    expect(before?.factSources).not.toHaveProperty('sameAs')
    const unresolved = await getModelDetail(d.db, resellerId, rawId)
    expect(unresolved?.sameAs).toBeNull()
    expect(unresolved?.factSources).not.toHaveProperty('sameAs')

    const native = {
      rawId: 'native-dated',
      aliases: ['native-alias'],
      pricing: GPT_4O,
      contextWindow: 200_000,
    }
    const maker = stub(makerId, [native], { modelNamespaces: ['publisher'] })
    await pollProviderModels(d, maker)
    const targetId = modelDbId(makerId, native.rawId)
    const after = await d.db.query.models.findFirst({
      where: eq(models.id, modelDbId(resellerId, rawId)),
    })
    // Establishing the relation changes only the link and its provenance.
    expect(after).toEqual({
      ...before,
      sameAsModelId: targetId,
      factSources: { ...(before?.factSources as object), sameAs: SOURCE },
    })
    const linked = await getModelDetail(d.db, resellerId, rawId)
    expect(linked?.sameAs).toEqual({ provider: makerId, rawId: native.rawId })
    expect(linked?.pricing).toBeNull()
    expect(linked?.contextWindow).toBe(1234)
    expect(linked?.factSources?.sameAs).toEqual(SOURCE)
    expect((await pollProviderModels(d, reseller)).updated).toBe(0)

    await d.db.delete(models).where(eq(models.id, targetId))
    expect((await getModelDetail(d.db, resellerId, rawId))?.sameAs).toBeNull()
    expect(
      (await getModelDetail(d.db, resellerId, rawId))?.factSources,
    ).not.toHaveProperty('sameAs')
    expect(
      (
        await d.db.query.models.findFirst({
          where: eq(models.id, modelDbId(resellerId, rawId)),
        })
      )?.sameAsModelId,
    ).toBeNull()
    // Retained evidence reconnects the same row after the maker returns.
    await pollProviderModels(d, maker)
    expect((await getModelDetail(d.db, resellerId, rawId))?.sameAs?.rawId).toBe(
      native.rawId,
    )

    await pollProviderModels(
      d,
      stub(
        resellerId,
        [{ rawId, contextWindow: 1234, upstreamModelIdentity: null }],
        { upstreamModelIdentity: identify },
      ),
    )
    const withdrawn = await d.db.query.models.findFirst({
      where: eq(models.id, modelDbId(resellerId, rawId)),
    })
    expect(withdrawn).toMatchObject({
      upstreamProvider: null,
      upstreamRawId: null,
      sameAsModelId: null,
    })
    expect(withdrawn?.factSources).not.toHaveProperty('sameAs')
  })

  it('requires an unambiguous provider and model identity, with exact ids preceding aliases', async () => {
    const d = deps()
    await pollProviderModels(
      d,
      stub(
        'identity-a',
        [
          { rawId: 'model', aliases: ['ambiguous'] },
          { rawId: 'other', aliases: ['ambiguous', 'model'] },
          { rawId: 'model-x' },
        ],
        { modelNamespaces: ['shared-publisher'] },
      ),
    )
    await pollProviderModels(
      d,
      stub('identity-b', [{ rawId: 'model' }], {
        modelNamespaces: ['shared-publisher', 'identity-a'],
      }),
    )
    await pollProviderModels(
      d,
      stub(
        'identity-host',
        [
          { rawId: 'shared-publisher/model' },
          { rawId: 'identity-a/model' },
          { rawId: 'identity-a/ambiguous' },
          { rawId: 'identity-a/MODEL-X' },
          { rawId: 'identity-a/model:free' },
        ],
        { upstreamModelIdentity: identify },
      ),
    )
    for (const rawId of [
      'shared-publisher/model',
      'identity-a/ambiguous',
      'identity-a/MODEL-X',
      'identity-a/model:free',
    ]) {
      expect(
        (await getModelDetail(d.db, 'identity-host', rawId))?.sameAs,
      ).toBeNull()
    }
    expect(
      (await getModelDetail(d.db, 'identity-host', 'identity-a/model'))?.sameAs,
    ).toEqual({ provider: 'identity-a', rawId: 'model' })
    expect(
      await d.db
        .select()
        .from(providerModelNamespaces)
        .where(eq(providerModelNamespaces.namespace, 'shared-publisher')),
    ).toHaveLength(2)

    await pollProviderModels(
      d,
      stub('identity-unproven-host', [
        { rawId: 'identity-a/model', displayName: 'model' },
      ]),
    )
    expect(
      (await getModelDetail(d.db, 'identity-unproven-host', 'identity-a/model'))
        ?.sameAs,
    ).toBeNull()
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

  it('ingests native identities from the issue’s gateways and Azure', async () => {
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
    ])
    await pollFixture(openaiProvider, [{ rawId: 'gpt-4o-2024-11-20' }])
    await pollFixture(geminiProvider, [{ rawId: 'gemini-2.5-pro' }])
    await pollFixture(workersAi, [{ rawId: '@cf/moonshotai/kimi-k2.6' }])
    await pollFixture(openrouterProvider, [
      { rawId: 'anthropic/claude-opus-4-5', contextWindow: 1234 },
      { rawId: 'claude-opus-4-5' },
      { rawId: 'openai/missing-native-model' },
    ])
    await pollFixture(vercel, [{ rawId: 'google/gemini-2.5-pro' }])
    await pollFixture(azure, [{ rawId: 'gpt-4o-2024-11-20' }])
    await ensureProviderRow(d.db, cloudflare)
    const cloudflareRawId = 'workers-ai/@cf/moonshotai/kimi-k2.6'
    await d.db.insert(models).values({
      id: modelDbId(cloudflare.id, cloudflareRawId),
      providerId: cloudflare.id,
      rawId: cloudflareRawId,
      firstSeenAt: 1,
      lastSeenAt: 1,
    })
    const skipped = await pollProviderModels(d, cloudflare)
    expect(skipped.skipped).toBeDefined()

    const cases = [
      [
        'openrouter',
        'anthropic/claude-opus-4-5',
        'anthropic',
        'claude-opus-4-5-20251101',
        'listing',
      ],
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
      [
        'cloudflare-ai-gateway',
        cloudflareRawId,
        'cloudflare-workers-ai',
        '@cf/moonshotai/kimi-k2.6',
        'docs-derived',
      ],
    ] as const
    for (const [provider, rawId, maker, nativeId, derivation] of cases) {
      const result = await getModelDetail(d.db, provider, rawId)
      expect(result?.sameAs).toEqual({ provider: maker, rawId: nativeId })
      expect(result?.factSources?.sameAs?.derivation).toBe(derivation)
      const stored = await d.db.query.models.findFirst({
        where: eq(models.id, modelDbId(provider, rawId)),
      })
      expect(stored?.sameAsModelId).toBe(modelDbId(maker, nativeId))
    }
    const opus = await getModelDetail(
      d.db,
      'openrouter',
      'anthropic/claude-opus-4-5',
    )
    expect(opus?.contextWindow).toBe(1234)
    expect(opus?.pricing).toBeNull()
    for (const rawId of ['claude-opus-4-5', 'openai/missing-native-model']) {
      const unlinked = await getModelDetail(d.db, 'openrouter', rawId)
      expect(unlinked?.sameAs).toBeNull()
      expect(unlinked?.factSources?.sameAs).toBeUndefined()
    }
  })
})
