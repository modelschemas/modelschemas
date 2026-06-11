import { beforeAll, describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'

import { getDb } from './../db/index.ts'
import type { Db } from './../db/index.ts'
import { models, providers } from '../db/schema.ts'
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
      provider: '/v1/providers/cat-alpha/models',
      schemas: '/v1/schemas/cat-alpha',
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
    expect(byRaw?._links.schemas).toBe('/v1/schemas/cat-beta')
    expect(await getModelDetail(db, 'cat-beta', 'missing')).toBeNull()
  })

  it('lists providers with status and links', async () => {
    const result = await listProvidersCatalog(db)
    const alpha = result.providers.find((p) => p.id === 'cat-alpha')
    expect(alpha?._links.models).toBe('/v1/providers/cat-alpha/models')
    expect(alpha?.counts.models).toBe(2)
  })
})
