import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'

import type { RateCard } from '@modelschemas/rate-card'

import { getDb } from '../../db/index.ts'
import {
  cacheMeta,
  changes,
  endpoints,
  models,
  providers,
  schemaVersions,
} from '../../db/schema.ts'
import { falLlmsTxtUrl } from '../providers/fal.ts'
import { modelDbId } from './poll-models.ts'
import {
  extractFalPricing,
  FAL_PRICING_FETCH_FAIL_ABORT,
  falPricingExtractCursorKey,
  pricingSection,
  pricingSectionHash,
} from './extract-fal-pricing.ts'
import type { ExtractCardArgs, ExtractedCard } from './extract-fal-pricing.ts'

const NOW = 1_781_150_000

const NANO_LLMS = `# Nano Banana 2

## Pricing

Your request will cost **$0.08** per image. For **$1.00**, you can run this model **12** times.

## API Information
`

const STUB_LLMS = `# Stub

## Pricing

For more details, see [fal.ai pricing](https://fal.ai/pricing).

## API Information
`

function dummySource(url: string): RateCard['source'] {
  return {
    url,
    hash: 'a'.repeat(64),
    extractedAt: '2026-01-01T00:00:00.000Z',
  }
}

function perImageCard(url: string): RateCard {
  return {
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
    source: dummySource(url),
  }
}

async function seedProvider(providerId: string): Promise<void> {
  const db = getDb(env)
  await db.insert(providers).values({
    id: providerId,
    displayName: 'FAL',
    specSourceUrl: 'https://api.fal.ai/v1/models',
  })
}

async function seedCandidate(args: {
  providerId: string
  rawId: string
  properties: Record<string, unknown>
  deprecated?: boolean
  activity?: 'image' | null
  pricing?: unknown
  factSources?: unknown
}): Promise<string> {
  const db = getDb(env)
  const id = modelDbId(args.providerId, args.rawId)
  const endpointId = `${args.providerId}/${args.rawId}`
  await db.insert(endpoints).values({
    id: endpointId,
    providerId: args.providerId,
    activity: args.activity === null ? 'image' : (args.activity ?? 'image'),
    method: 'POST',
    path: `/${args.rawId}`,
  })
  await db.insert(schemaVersions).values({
    id: `${endpointId}:input`,
    endpointId,
    kind: 'input',
    contentHash: 'b'.repeat(64),
    schema: JSON.stringify({ properties: args.properties }),
    derivation: 'upstream-spec',
    createdAt: NOW,
  })
  await db.insert(models).values({
    id,
    providerId: args.providerId,
    rawId: args.rawId,
    activity: args.activity === undefined ? 'image' : args.activity,
    pricing: args.pricing ?? null,
    factSources: args.factSources ?? null,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    deprecatedAt: args.deprecated ? NOW : null,
  })
  return id
}

describe('extractFalPricing', () => {
  it('extracts a verified card, hash-skips night two, and rotates the cursor', async () => {
    const providerId = 'extract-main'
    await seedProvider(providerId)
    await seedCandidate({
      providerId,
      rawId: 'fal-ai/nano-banana-2',
      properties: {
        num_images: { type: 'integer' },
        prompt: { type: 'string' },
      },
    })
    await seedCandidate({
      providerId,
      rawId: 'fal-ai/other',
      properties: { num_images: { type: 'integer' } },
    })

    const files = new Map<string, string>([
      [falLlmsTxtUrl('fal-ai/nano-banana-2'), NANO_LLMS],
      [falLlmsTxtUrl('fal-ai/other'), NANO_LLMS],
    ])
    const extractedRawIds: Array<string> = []
    const extractCard = async (
      args: ExtractCardArgs,
    ): Promise<ExtractedCard> => {
      extractedRawIds.push(args.sourceUrl)
      return perImageCard(args.sourceUrl)
    }

    const db = getDb(env)
    const deps = {
      db,
      kv: env.SCHEMA_CACHE,
      secrets: {},
      now: () => NOW,
      providerId,
      fetchCap: 10,
      extractCap: 10,
      fetchText: (url: string) => Promise.resolve(files.get(url) ?? null),
      extractCard,
    }

    const first = await extractFalPricing(deps)
    expect(first).toMatchObject({
      candidates: 2,
      fetched: 2,
      extracted: 2,
      written: 2,
      hashSkipped: 0,
    })
    const nano = await db.query.models.findFirst({
      where: eq(models.id, modelDbId(providerId, 'fal-ai/nano-banana-2')),
    })
    const card = nano?.pricing as RateCard | null
    expect(card?.inputs.num_images).toMatchObject({ param: 'num_images' })
    expect(card?.source.hash).toBe(
      await pricingSectionHash(pricingSection(NANO_LLMS)),
    )
    expect(card?.source.url).toBe(falLlmsTxtUrl('fal-ai/nano-banana-2'))
    const sources = nano?.factSources as {
      pricing?: { derivation: string; sourceHash: string }
    }
    expect(sources.pricing?.derivation).toBe('docs-extracted')
    expect(
      await db.select().from(changes).where(eq(changes.providerId, providerId)),
    ).toHaveLength(2)

    extractedRawIds.length = 0
    const second = await extractFalPricing(deps)
    expect(second).toMatchObject({
      fetched: 2,
      extracted: 0,
      written: 0,
      hashSkipped: 2,
    })
    expect(extractedRawIds).toEqual([])
    expect(
      await db.select().from(changes).where(eq(changes.providerId, providerId)),
    ).toHaveLength(2)
  })

  it('caps fetches and resumes after the cursor', async () => {
    const providerId = 'extract-cursor'
    await seedProvider(providerId)
    const rawIds = ['fal-ai/a', 'fal-ai/b', 'fal-ai/c']
    for (const rawId of rawIds) {
      await seedCandidate({
        providerId,
        rawId,
        properties: { num_images: { type: 'integer' } },
      })
    }
    const seen: Array<string> = []
    const deps = {
      db: getDb(env),
      kv: env.SCHEMA_CACHE,
      secrets: {},
      now: () => NOW,
      providerId,
      fetchCap: 2,
      extractCap: 20,
      fetchText: (url: string) => {
        seen.push(url)
        return Promise.resolve(NANO_LLMS)
      },
      extractCard: async (args: ExtractCardArgs): Promise<ExtractedCard> =>
        perImageCard(args.sourceUrl),
    }
    const first = await extractFalPricing(deps)
    expect(first.fetched).toBe(2)
    expect(first.cursor).toBe('fal-ai/b')
    expect(
      seen.map((url) =>
        url.replace(/.*\/models\//, '').replace(/\/llms.txt$/, ''),
      ),
    ).toEqual(['fal-ai/a', 'fal-ai/b'])
    const cursorRow = await getDb(env).query.cacheMeta.findFirst({
      where: eq(cacheMeta.key, falPricingExtractCursorKey(providerId)),
    })
    expect(cursorRow?.lastError).toBe('fal-ai/b')

    seen.length = 0
    const second = await extractFalPricing(deps)
    expect(second.fetched).toBe(2)
    expect(
      seen.map((url) =>
        url.replace(/.*\/models\//, '').replace(/\/llms.txt$/, ''),
      ),
    ).toEqual(['fal-ai/c', 'fal-ai/a'])
  })

  it('writes null for a stub Pricing section and keeps a previous card on unverified', async () => {
    const providerId = 'extract-stub'
    await seedProvider(providerId)
    const stubId = await seedCandidate({
      providerId,
      rawId: 'fal-ai/stub',
      properties: { prompt: { type: 'string' } },
    })
    const keptId = await seedCandidate({
      providerId,
      rawId: 'fal-ai/kept',
      properties: { num_images: { type: 'integer' } },
      pricing: perImageCard(falLlmsTxtUrl('fal-ai/kept')),
    })
    const files = new Map<string, string>([
      [falLlmsTxtUrl('fal-ai/stub'), STUB_LLMS],
      [falLlmsTxtUrl('fal-ai/kept'), NANO_LLMS],
    ])
    await extractFalPricing({
      db: getDb(env),
      kv: env.SCHEMA_CACHE,
      secrets: {},
      now: () => NOW,
      providerId,
      fetchText: (url: string) => Promise.resolve(files.get(url) ?? null),
      extractCard: async () => 'unverified',
    })
    const stub = await getDb(env).query.models.findFirst({
      where: eq(models.id, stubId),
    })
    const kept = await getDb(env).query.models.findFirst({
      where: eq(models.id, keptId),
    })
    expect(stub?.pricing).toBeNull()
    expect(kept?.pricing).toMatchObject({
      inputs: { num_images: { param: 'num_images' } },
    })
    expect(
      (kept?.factSources as { pricing?: { derivation: string } }).pricing
        ?.derivation,
    ).toBe('docs-extracted')
  })

  it('refuses invented request params and expired hash-skips re-extract', async () => {
    const providerId = 'extract-refuse'
    await seedProvider(providerId)
    const inventedId = await seedCandidate({
      providerId,
      rawId: 'fal-ai/invented',
      properties: { prompt: { type: 'string' } },
    })
    const expiredId = await seedCandidate({
      providerId,
      rawId: 'fal-ai/expired',
      properties: { num_images: { type: 'integer' } },
      pricing: {
        ...perImageCard(falLlmsTxtUrl('fal-ai/expired')),
        source: {
          ...dummySource(falLlmsTxtUrl('fal-ai/expired')),
          hash: await pricingSectionHash(pricingSection(NANO_LLMS)),
          expiresAt: '2020-01-01T00:00:00.000Z',
        },
      },
    })
    let extracts = 0
    await extractFalPricing({
      db: getDb(env),
      kv: env.SCHEMA_CACHE,
      secrets: {},
      now: () => NOW,
      providerId,
      fetchText: () => Promise.resolve(NANO_LLMS),
      extractCard: async (args: ExtractCardArgs): Promise<ExtractedCard> => {
        extracts++
        if (args.sourceUrl.includes('invented')) {
          return {
            inputs: {
              quality: { param: 'quality', kind: 'enum', values: ['hd'] },
            },
            tables: {},
            price: 0.08,
            examples: [
              { params: {}, usd: 0.08, quote: 'Your request will cost $0.08' },
            ],
            source: dummySource(args.sourceUrl),
          }
        }
        return perImageCard(args.sourceUrl)
      },
    })
    expect(extracts).toBe(2)
    const invented = await getDb(env).query.models.findFirst({
      where: eq(models.id, inventedId),
    })
    expect(invented?.pricing).toBeNull()
    const expired = await getDb(env).query.models.findFirst({
      where: eq(models.id, expiredId),
    })
    expect(
      (expired?.pricing as RateCard | null)?.source.expiresAt,
    ).toBeUndefined()
  })

  it('skips deprecated rows and rows with no input schema', async () => {
    const providerId = 'extract-skip'
    await seedProvider(providerId)
    await seedCandidate({
      providerId,
      rawId: 'fal-ai/live',
      properties: { num_images: { type: 'integer' } },
    })
    await seedCandidate({
      providerId,
      rawId: 'fal-ai/old',
      properties: { num_images: { type: 'integer' } },
      deprecated: true,
    })
    await getDb(env)
      .insert(models)
      .values({
        id: modelDbId(providerId, 'fal-ai/no-schema'),
        providerId,
        rawId: 'fal-ai/no-schema',
        activity: 'image',
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      })
    const fetched: Array<string> = []
    const outcome = await extractFalPricing({
      db: getDb(env),
      kv: env.SCHEMA_CACHE,
      secrets: {},
      now: () => NOW,
      providerId,
      fetchText: (url: string) => {
        fetched.push(url)
        return Promise.resolve(NANO_LLMS)
      },
      extractCard: async (args: ExtractCardArgs) =>
        perImageCard(args.sourceUrl),
    })
    expect(outcome.candidates).toBe(1)
    expect(fetched).toEqual([falLlmsTxtUrl('fal-ai/live')])
  })

  it('stops extracting at the extract cap and retries the leftover next run', async () => {
    const providerId = 'extract-cap'
    await seedProvider(providerId)
    for (const rawId of ['fal-ai/a', 'fal-ai/b', 'fal-ai/c']) {
      await seedCandidate({
        providerId,
        rawId,
        properties: { num_images: { type: 'integer' } },
      })
    }
    let extracts = 0
    const deps = {
      db: getDb(env),
      kv: env.SCHEMA_CACHE,
      secrets: {},
      now: () => NOW,
      providerId,
      fetchCap: 200,
      extractCap: 1,
      fetchText: () => Promise.resolve(NANO_LLMS),
      extractCard: async (args: ExtractCardArgs): Promise<ExtractedCard> => {
        extracts++
        return perImageCard(args.sourceUrl)
      },
    }
    const first = await extractFalPricing(deps)
    expect(first.extracted).toBe(1)
    expect(first.written).toBe(1)
    expect(extracts).toBe(1)
    extracts = 0
    const second = await extractFalPricing(deps)
    expect(second.extracted).toBe(1)
    expect(extracts).toBe(1)
  })

  it('skips the run when XAI_API_KEY is missing and does not move the cursor', async () => {
    const providerId = 'extract-nokey'
    await seedProvider(providerId)
    await seedCandidate({
      providerId,
      rawId: 'fal-ai/nano-banana-2',
      properties: { num_images: { type: 'integer' } },
    })
    const fetched: Array<string> = []
    const outcome = await extractFalPricing({
      db: getDb(env),
      kv: env.SCHEMA_CACHE,
      secrets: {},
      now: () => NOW,
      providerId,
      fetchText: (url: string) => {
        fetched.push(url)
        return Promise.resolve(NANO_LLMS)
      },
    })
    expect(outcome.skipped).toContain('XAI_API_KEY')
    expect(outcome.fetched).toBe(0)
    expect(fetched).toEqual([])
    expect(outcome.cursor).toBeNull()
    expect(
      await getDb(env).query.cacheMeta.findFirst({
        where: eq(cacheMeta.key, falPricingExtractCursorKey(providerId)),
      }),
    ).toBeUndefined()
  })

  it('does not advance the cursor on retryable llms.txt failures', async () => {
    const providerId = 'extract-fetchfail'
    await seedProvider(providerId)
    for (const rawId of ['fal-ai/a', 'fal-ai/b', 'fal-ai/c']) {
      await seedCandidate({
        providerId,
        rawId,
        properties: { num_images: { type: 'integer' } },
      })
    }
    const seen: Array<string> = []
    const deps = {
      db: getDb(env),
      kv: env.SCHEMA_CACHE,
      secrets: {},
      now: () => NOW,
      providerId,
      fetchText: (url: string) => {
        seen.push(url)
        if (url.includes('/fal-ai/a/')) return Promise.resolve(NANO_LLMS)
        return Promise.resolve({ status: 503 })
      },
      extractCard: async (args: ExtractCardArgs): Promise<ExtractedCard> =>
        perImageCard(args.sourceUrl),
    }
    const first = await extractFalPricing(deps)
    expect(first.cursor).toBe('fal-ai/a')
    expect(first.fetchFailed).toBe(2)
    expect(first.written).toBe(1)
    seen.length = 0
    const second = await extractFalPricing(deps)
    expect(
      seen.map((url) =>
        url.replace(/.*\/models\//, '').replace(/\/llms.txt$/, ''),
      )[0],
    ).toBe('fal-ai/b')
    expect(second.cursor).toBe('fal-ai/a')
  })

  it('aborts after consecutive retryable fetches without saving a cursor', async () => {
    const providerId = 'extract-fetchabort'
    await seedProvider(providerId)
    const rawIds = Array.from(
      { length: FAL_PRICING_FETCH_FAIL_ABORT + 2 },
      (_, i) => `fal-ai/${String(i).padStart(2, '0')}`,
    )
    for (const rawId of rawIds) {
      await seedCandidate({
        providerId,
        rawId,
        properties: { num_images: { type: 'integer' } },
      })
    }
    const seen: Array<string> = []
    const outcome = await extractFalPricing({
      db: getDb(env),
      kv: env.SCHEMA_CACHE,
      secrets: {},
      now: () => NOW,
      providerId,
      fetchText: (url: string) => {
        seen.push(url)
        return Promise.resolve({ status: 503 })
      },
      extractCard: async () => {
        throw new Error('extract should not run')
      },
    })
    expect(outcome.fetched).toBe(FAL_PRICING_FETCH_FAIL_ABORT)
    expect(outcome.fetchFailed).toBe(FAL_PRICING_FETCH_FAIL_ABORT)
    expect(outcome.cursor).toBeNull()
    expect(seen).toHaveLength(FAL_PRICING_FETCH_FAIL_ABORT)
    expect(
      await getDb(env).query.cacheMeta.findFirst({
        where: eq(cacheMeta.key, falPricingExtractCursorKey(providerId)),
      }),
    ).toBeUndefined()
  })

  it('keeps a previous card and stamps the hash when examples are empty', async () => {
    const providerId = 'extract-empty-ex'
    await seedProvider(providerId)
    const rawId = 'fal-ai/kept'
    const previous = perImageCard(falLlmsTxtUrl(rawId))
    const id = await seedCandidate({
      providerId,
      rawId,
      properties: { num_images: { type: 'integer' } },
      pricing: previous,
      factSources: {
        pricing: {
          derivation: 'docs-extracted',
          sourceUrl: falLlmsTxtUrl(rawId),
          sourceHash: previous.source.hash,
          fetchedAt: NOW,
        },
      },
    })
    const outcome = await extractFalPricing({
      db: getDb(env),
      kv: env.SCHEMA_CACHE,
      secrets: {},
      now: () => NOW,
      providerId,
      fetchText: () => Promise.resolve(NANO_LLMS),
      extractCard: async (args: ExtractCardArgs): Promise<ExtractedCard> => ({
        ...perImageCard(args.sourceUrl),
        examples: [],
      }),
    })
    expect(outcome.unverified).toBe(1)
    expect(outcome.written).toBe(0)
    const row = await getDb(env).query.models.findFirst({
      where: eq(models.id, id),
    })
    expect(row?.pricing).toMatchObject({
      inputs: { num_images: { param: 'num_images' } },
    })
    const sectionHash = await pricingSectionHash(pricingSection(NANO_LLMS))
    expect(
      (row?.factSources as { pricing?: { sourceHash: string } }).pricing
        ?.sourceHash,
    ).toBe(sectionHash)
  })

  it('keeps a previous card and does not stamp the hash when verifyExamples fails', async () => {
    const providerId = 'extract-verifyfail'
    await seedProvider(providerId)
    const rawId = 'fal-ai/kept'
    const previousHash = 'a'.repeat(64)
    const previous = perImageCard(falLlmsTxtUrl(rawId))
    const id = await seedCandidate({
      providerId,
      rawId,
      properties: { num_images: { type: 'integer' } },
      pricing: previous,
      factSources: {
        pricing: {
          derivation: 'docs-extracted',
          sourceUrl: falLlmsTxtUrl(rawId),
          sourceHash: previousHash,
          fetchedAt: NOW,
        },
      },
    })
    const outcome = await extractFalPricing({
      db: getDb(env),
      kv: env.SCHEMA_CACHE,
      secrets: {},
      now: () => NOW,
      providerId,
      fetchText: () => Promise.resolve(NANO_LLMS),
      extractCard: async (args: ExtractCardArgs): Promise<ExtractedCard> => ({
        ...perImageCard(args.sourceUrl),
        examples: [
          {
            params: {},
            usd: 999,
            quote: 'Your request will cost $0.08 per image',
          },
        ],
      }),
    })
    expect(outcome.refused).toBe(1)
    expect(outcome.written).toBe(0)
    const row = await getDb(env).query.models.findFirst({
      where: eq(models.id, id),
    })
    expect((row?.pricing as RateCard | null)?.examples[0]?.usd).toBe(0.08)
    expect(
      (row?.factSources as { pricing?: { sourceHash: string } }).pricing
        ?.sourceHash,
    ).toBe(previousHash)
  })

  it('writes null over a previous card when Pricing is a stub', async () => {
    const providerId = 'extract-stub-overwrite'
    await seedProvider(providerId)
    const rawId = 'fal-ai/stub'
    const id = await seedCandidate({
      providerId,
      rawId,
      properties: { prompt: { type: 'string' } },
      pricing: perImageCard(falLlmsTxtUrl(rawId)),
      factSources: {
        pricing: {
          derivation: 'docs-extracted',
          sourceUrl: falLlmsTxtUrl(rawId),
          sourceHash: 'a'.repeat(64),
          fetchedAt: NOW,
        },
      },
    })
    const outcome = await extractFalPricing({
      db: getDb(env),
      kv: env.SCHEMA_CACHE,
      secrets: {},
      now: () => NOW,
      providerId,
      fetchText: () => Promise.resolve(STUB_LLMS),
      extractCard: async () => {
        throw new Error('extract should not run on a stub')
      },
    })
    expect(outcome.refused).toBe(1)
    expect(outcome.written).toBe(1)
    const row = await getDb(env).query.models.findFirst({
      where: eq(models.id, id),
    })
    expect(row?.pricing).toBeNull()
    const sources = row?.factSources as {
      pricing?: { derivation: string; sourceHash: string }
    }
    expect(sources.pricing?.derivation).toBe('docs-extracted')
    expect(sources.pricing?.sourceHash).toBe(
      await pricingSectionHash(pricingSection(STUB_LLMS)),
    )
  })
})
