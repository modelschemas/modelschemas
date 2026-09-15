import { beforeAll, describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'

import { getDb } from './../db/index.ts'
import type { Db } from './../db/index.ts'
import { models, providers } from '../db/schema.ts'
import { GPT_4O } from '../../packages/rate-card/src/fixtures/gpt-4o.ts'
import { NANO_BANANA_2 } from '../../packages/rate-card/src/fixtures/nano-banana-2.ts'
import {
  getModelDetail,
  listModelsCatalog,
  listProviderModels,
  listProvidersCatalog,
} from './catalog.ts'

const NOW = 1_781_150_000
let db: Db

beforeAll(async () => {
  db = getDb(env)
  await db.insert(providers).values([
    {
      id: 'cat-alpha',
      displayName: 'Catalog Alpha',
      specSourceUrl: 'https://example.com/a.json',
    },
    {
      id: 'cat-beta',
      displayName: 'Catalog Beta',
      specSourceUrl: 'https://example.com/b.json',
    },
  ])
  await db.insert(models).values([
    {
      id: 'cat-alpha-chatty',
      providerId: 'cat-alpha',
      rawId: 'chatty-1',
      activity: 'chat',
      displayName: 'Chatty One',
      contextWindow: 100_000,
      capabilities: ['tools', 'vision'],
      firstSeenAt: NOW,
      lastSeenAt: NOW,
    },
    {
      id: 'cat-alpha-paint',
      providerId: 'cat-alpha',
      rawId: 'painter-xl',
      activity: 'image',
      displayName: 'Painter XL',
      firstSeenAt: NOW,
      lastSeenAt: NOW,
    },
    {
      id: 'cat-beta-chatter',
      providerId: 'cat-beta',
      rawId: 'beta/chatter',
      activity: 'chat',
      displayName: 'Beta Chatter',
      capabilities: ['tools'],
      firstSeenAt: NOW,
      lastSeenAt: NOW,
    },
    {
      id: 'cat-beta-oldie',
      providerId: 'cat-beta',
      rawId: 'oldie',
      activity: 'chat',
      displayName: 'Oldie',
      firstSeenAt: NOW,
      lastSeenAt: NOW,
      deprecatedAt: NOW,
    },
  ])
})

const catalogIds = async (filters: Parameters<typeof listModelsCatalog>[1]) =>
  (await listModelsCatalog(db, filters)).models
    .map((m) => m.id)
    .filter((id) => id.startsWith('cat-'))

describe('listModelsCatalog filters', () => {
  it('excludes deprecated models by default, includes them on request', async () => {
    expect(await catalogIds({ provider: 'cat-beta' })).toEqual([
      'cat-beta-chatter',
    ])
    expect(
      await catalogIds({ provider: 'cat-beta', includeDeprecated: true }),
    ).toEqual(['cat-beta-chatter', 'cat-beta-oldie'])
  })

  it('filters by activity and provider', async () => {
    expect(await catalogIds({ activity: 'chat' })).toEqual([
      'cat-alpha-chatty',
      'cat-beta-chatter',
    ])
    expect(await catalogIds({ activity: 'image' })).toEqual(['cat-alpha-paint'])
    expect(await catalogIds({ provider: 'cat-alpha' })).toEqual([
      'cat-alpha-chatty',
      'cat-alpha-paint',
    ])
  })

  it('filters by capability substring and free text', async () => {
    expect(await catalogIds({ capability: 'vision' })).toEqual([
      'cat-alpha-chatty',
    ])
    expect(await catalogIds({ capability: 'tools' })).toEqual([
      'cat-alpha-chatty',
      'cat-beta-chatter',
    ])
    expect(await catalogIds({ q: 'painter' })).toEqual(['cat-alpha-paint'])
    expect(await catalogIds({ q: 'CHATT' })).toEqual([
      'cat-alpha-chatty',
      'cat-beta-chatter',
    ])
  })

  it('combines filters and attaches _links', async () => {
    const result = await listModelsCatalog(db, {
      activity: 'chat',
      provider: 'cat-alpha',
    })
    expect(result.models.map((m) => m.id)).toEqual(['cat-alpha-chatty'])
    expect(result.models[0]?._links).toEqual({
      provider: {
        href: '/v1/providers/cat-alpha/models',
        method: 'GET',
        contentType: 'application/json',
      },
      schemas: {
        href: '/v1/schemas/cat-alpha',
        method: 'GET',
        contentType: 'application/json',
      },
    })
    expect(result.models[0]?._links).not.toHaveProperty('openapi')
  })

  it('advertises spec grain and OpenAPI links for registered providers', async () => {
    await db
      .insert(providers)
      .values({
        id: 'fal',
        displayName: 'FAL',
        specSourceUrl: 'https://example.com/f.json',
      })
      .onConflictDoNothing()
    const fal = (await listProvidersCatalog(db)).providers.find(
      (p) => p.id === 'fal',
    )
    expect(fal?.spec.grain).toBe('model')
    expect(fal?._links.openapi).toMatchObject({
      href: '/v1/openapi/fal{?model}',
      contentType: 'application/openapi+json',
      templated: true,
    })
  })
})

describe('provider-scoped queries', () => {
  it('lists one provider, including deprecated models', async () => {
    const result = await listProviderModels(db, 'cat-beta')
    expect(result?.count).toBe(2)
    expect(await listProviderModels(db, 'nope')).toBeNull()
  })

  it('resolves model detail by slug and by raw id', async () => {
    const bySlug = await getModelDetail(db, 'cat-beta', 'cat-beta-chatter')
    const byRaw = await getModelDetail(db, 'cat-beta', 'beta/chatter')
    expect(bySlug?.id).toBe('cat-beta-chatter')
    expect(byRaw?.id).toBe('cat-beta-chatter')
    expect(byRaw?._links.schemas.href).toBe('/v1/schemas/cat-beta')
    expect(byRaw?.schemaEndpointId).toBeNull()
    expect(byRaw?.factSources).toBeNull()
    expect(byRaw?.discrepancies).toEqual([])
    expect(await getModelDetail(db, 'cat-beta', 'missing')).toBeNull()
  })

  it('omits factSources on the list unless provenance is requested', async () => {
    const listed = await listModelsCatalog(db, { provider: 'cat-alpha' })
    expect(listed.models[0]).not.toHaveProperty('factSources')
    const withProv = await listModelsCatalog(db, {
      provider: 'cat-alpha',
      provenance: true,
    })
    expect(withProv.models[0]?.factSources).toBeNull()
  })

  it('binds grain=provider models to a generation route and FAL to its raw id', async () => {
    await db
      .insert(providers)
      .values([
        {
          id: 'grok',
          displayName: 'xAI Grok',
          specSourceUrl: 'https://example.com/g.json',
        },
        {
          id: 'fal',
          displayName: 'FAL',
          specSourceUrl: 'https://example.com/f.json',
        },
      ])
      .onConflictDoNothing()
    await db.insert(models).values([
      {
        id: 'grok-grok-imagine-image-2-0',
        providerId: 'grok',
        rawId: 'grok-imagine-image-2.0',
        activity: 'image',
        displayName: 'Grok Imagine Image 2.0',
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      },
      {
        id: 'fal-xai-grok-imagine',
        providerId: 'fal',
        rawId: 'xai/grok-imagine-image/v2.0/text-to-image',
        activity: 'image',
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      },
    ])

    const grok = await getModelDetail(db, 'grok', 'grok-imagine-image-2.0')
    expect(grok?.schemaEndpointId).toBe('v1/images/generations')
    expect(grok?._links.schema).toMatchObject({
      href: '/v1/schemas/grok/image/v1/images/generations',
      method: 'GET',
    })
    expect(
      (await listModelsCatalog(db, { provider: 'grok', activity: 'image' }))
        .models,
    ).toHaveLength(1)

    const fal = await getModelDetail(
      db,
      'fal',
      'xai/grok-imagine-image/v2.0/text-to-image',
    )
    expect(fal?.schemaEndpointId).toBe(
      'xai/grok-imagine-image/v2.0/text-to-image',
    )
  })

  it('lists providers with status and links', async () => {
    const result = await listProvidersCatalog(db)
    const alpha = result.providers.find((p) => p.id === 'cat-alpha')
    expect(alpha?._links.models.href).toBe('/v1/providers/cat-alpha/models')
    expect(alpha?.counts.models).toBe(2)
  })
})

describe('catalog rate cards', () => {
  beforeAll(async () => {
    await db.insert(providers).values({
      id: 'cat-price',
      displayName: 'Catalog Price',
      specSourceUrl: 'https://example.com/p.json',
    })
    await db.insert(models).values([
      {
        id: 'cat-price-gpt-4o',
        providerId: 'cat-price',
        rawId: 'gpt-4o',
        activity: 'chat',
        displayName: 'GPT-4o',
        pricing: GPT_4O,
        factSources: { pricing: { derivation: 'listing' } },
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      },
      {
        id: 'cat-price-nano',
        providerId: 'cat-price',
        rawId: 'nano-banana-2',
        activity: 'image',
        displayName: 'Nano Banana 2',
        pricing: NANO_BANANA_2,
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      },
      {
        id: 'cat-price-blob',
        providerId: 'cat-price',
        rawId: 'blob',
        activity: 'chat',
        pricing: { prompt: '0.0000025', completion: '0.00001' },
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      },
    ])
  })

  it('projects simple token cards on the list and omits media tables', async () => {
    const listed = await listModelsCatalog(db, { provider: 'cat-price' })
    const byId = Object.fromEntries(listed.models.map((m) => [m.id, m]))
    expect(byId['cat-price-gpt-4o']?.pricing).toEqual({
      inputPerMillion: 2.5,
      outputPerMillion: 10,
    })
    expect(byId['cat-price-nano']?.pricing).toBeNull()
    expect(byId['cat-price-blob']?.pricing).toBeNull()
    expect(listed._links.self.href).toContain('pricing')
  })

  it('includes the full card on list rows when pricing=1', async () => {
    const listed = await listModelsCatalog(db, {
      provider: 'cat-price',
      pricing: true,
    })
    const gpt = listed.models.find((m) => m.id === 'cat-price-gpt-4o')
    const nano = listed.models.find((m) => m.id === 'cat-price-nano')
    expect(gpt?.pricing).toEqual(GPT_4O)
    expect(nano?.pricing).toEqual(NANO_BANANA_2)
  })

  it('always includes the full card (or null) on detail', async () => {
    const gpt = await getModelDetail(db, 'cat-price', 'gpt-4o')
    const nano = await getModelDetail(db, 'cat-price', 'nano-banana-2')
    const blob = await getModelDetail(db, 'cat-price', 'blob')
    expect(gpt?.pricing).toEqual(GPT_4O)
    expect(gpt?.factSources).toEqual({ pricing: { derivation: 'listing' } })
    expect(nano?.pricing).toEqual(NANO_BANANA_2)
    expect(blob?.pricing).toBeNull()
  })
})
