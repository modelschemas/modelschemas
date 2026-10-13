import { price } from '@modelschemas/rate-card'
import type { RateCard } from '@modelschemas/rate-card'
import { OPENCODE_CATALOG_URL } from '../opencode-catalog.ts'

import { afterEach, describe, expect, it } from 'vitest'

import { OPENCODE_MODELS_URL, provider } from './opencode.ts'

/** Excerpt-shaped listing. Ids are fixtures, not a live snapshot. */
const LISTING = {
  object: 'list',
  data: ['opus', 'gpt', 'gemini', 'qwen', 'pickle', 'unlisted', 'mistral'].map(
    (id) => ({ id, object: 'model', owned_by: 'opencode' }),
  ),
}

const CATALOG = {
  opencode: {
    npm: '@ai-sdk/openai-compatible',
    api: 'https://opencode.ai/inference/v1',
    models: {
      opus: {
        id: 'opus',
        name: 'Opus',
        provider: { npm: '@ai-sdk/anthropic' },
        limit: { context: 1234, output: 234 },
        tool_call: true,
        reasoning_options: [{ type: 'budget_tokens', min: 1 }],
        interleaved: { field: 'reasoning_content' },
        cost: { input: 4, output: 20, cache_read: 0.2, cache_write: 5 },
      },
      gpt: {
        id: 'gpt',
        name: 'GPT',
        provider: { npm: '@ai-sdk/openai' },
        cost: {
          input: 5,
          output: 30,
          cache_read: 0.5,
          tiers: [
            {
              input: 10,
              output: 45,
              cache_read: 1,
              tier: { type: 'context', size: 272000 },
            },
          ],
          context_over_200k: { input: 10, output: 45, cache_read: 1 },
        },
      },
      gemini: {
        id: 'gemini',
        name: 'Gemini',
        provider: { npm: '@ai-sdk/google' },
        cost: { input: 2, output: 12, cache_read: 0.2 },
      },
      qwen: {
        id: 'qwen',
        name: 'Qwen',
        cost: { input: 2, output: 6, cache_read: 0.25, cache_write: 2.5 },
      },
      pickle: {
        id: 'pickle',
        name: 'Pickle',
        cost: { input: 0, output: 0, cache_read: 0 },
      },
      mistral: {
        id: 'mistral',
        name: 'Mistral',
        provider: { npm: '@ai-sdk/mistral' },
        cost: { input: 1, output: 2 },
      },
    },
  },
}

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function serve(catalog: unknown = CATALOG) {
  const urls: Array<string> = []
  globalThis.fetch = ((url: string) => {
    urls.push(String(url))
    if (String(url) === OPENCODE_MODELS_URL) {
      return Promise.resolve(new Response(JSON.stringify(LISTING)))
    }
    if (String(url) === OPENCODE_CATALOG_URL) {
      return Promise.resolve(new Response(JSON.stringify(catalog)))
    }
    if (
      String(url).startsWith(
        'https://raw.githubusercontent.com/anomalyco/opencode/dev/',
      )
    ) {
      return Promise.resolve(
        new Response('export function POST(input: APIEvent) {}'),
      )
    }
    return Promise.reject(new Error(`unexpected fetch: ${String(url)}`))
  }) as typeof fetch
  return urls
}

type Card = { tables: { rate: Record<string, Record<string, number>> } }

describe('opencode', () => {
  it('reads routes and prices from the catalog, not the removed docs page', async () => {
    const urls = serve()
    const { models } = await provider.listModels({})
    const byId = Object.fromEntries(models.map((m) => [m.rawId, m]))

    expect(models.map((m) => m.rawId)).toEqual(LISTING.data.map((r) => r.id))
    expect(urls.some((url) => url.includes('/docs/'))).toBe(false)

    expect(byId.opus).toMatchObject({
      displayName: 'Opus',
      activity: 'chat',
      schemaEndpointId: 'inference/v1/messages',
      contextWindow: 1234,
      factSources: {
        pricing: { derivation: 'listing', sourceUrl: OPENCODE_CATALOG_URL },
        schemaEndpointId: {
          derivation: 'listing',
          path: 'opencode.models.opus.provider.npm',
        },
      },
    })
    expect((byId.opus?.pricing as Card).tables.rate).toEqual({
      base: {
        input_tokens: 4 / 1e6,
        output_tokens: 20 / 1e6,
        cache_read_tokens: 0.2 / 1e6,
        cache_write_tokens: 5 / 1e6,
      },
    })

    expect((byId.gpt?.pricing as Card).tables.rate).toEqual({
      base: {
        input_tokens: 5 / 1e6,
        output_tokens: 30 / 1e6,
        cache_read_tokens: 0.5 / 1e6,
      },
      '272000': {
        input_tokens: 10 / 1e6,
        output_tokens: 45 / 1e6,
        cache_read_tokens: 1 / 1e6,
      },
    })
    expect(byId.gpt?.schemaEndpointId).toBe('inference/v1/responses')
    expect(byId.gemini?.schemaEndpointId).toBe('inference/v1/models/gemini')
    expect(byId.qwen?.schemaEndpointId).toBe('inference/v1/chat/completions')
    expect(byId.qwen?.factSources?.schemaEndpointId?.path).toBe('opencode.npm')

    expect(byId.pickle).toMatchObject({
      activity: 'chat',
      pricing: {
        price: 0,
        tables: {
          rate: {
            base: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 },
          },
        },
      },
    })
    expect(
      price(
        byId.pickle!.pricing as RateCard,
        {},
        { input_tokens: 10_000, output_tokens: 2_000, cache_read_tokens: 300 },
      ),
    ).toBe(0)

    expect(byId.mistral?.displayName).toBe('Mistral')
    expect(byId.mistral?.schemaEndpointId).toBeUndefined()
    expect(byId.mistral?.activity).toBeUndefined()
    expect(byId.mistral?.pricing).toBeTruthy()

    expect(byId.unlisted).toEqual({
      rawId: 'unlisted',
      releasedAt: null,
      absent: { releasedAt: 'cleared', pricing: 'cleared' },
      pricing: null,
    })
    expect(provider.bindSyncedRoutesOnly).toBe(true)

    const spec = await provider.fetchSpec({})
    expect(
      spec.specs[0]?.paths?.['/inference/v1/messages']?.post,
    ).toMatchObject({
      'x-modelschemas-route-only': true,
    })
    expect(spec.specs[0]?.paths?.['/v1/messages']).toBeUndefined()
    const source = spec.specs[0]?.paths?.['/inference/v1/messages']?.post?.[
      'x-modelschemas-method-source'
    ] as { url: string }
    expect(source.url).toContain('/zen/v1/messages.ts')
  })

  it('fails the poll when the catalog is unavailable', async () => {
    serve()
    const fetchCatalog = globalThis.fetch
    globalThis.fetch = ((url: string, init?: RequestInit) =>
      String(url) === OPENCODE_CATALOG_URL
        ? Promise.resolve(new Response('unavailable', { status: 503 }))
        : fetchCatalog(url, init)) as typeof fetch
    await expect(provider.listModels({})).rejects.toThrow()
  })

  it('prices a model that was free once the catalog quotes a rate', async () => {
    const catalog = structuredClone(CATALOG)
    catalog.opencode.models.pickle.cost = {
      input: 0.1,
      output: 0.2,
      cache_read: 0.01,
    }
    serve(catalog)
    const paid = (await provider.listModels({})).models.find(
      (model) => model.rawId === 'pickle',
    )!
    expect(
      price(
        paid.pricing as RateCard,
        {},
        { input_tokens: 1_000_000, output_tokens: 1_000_000 },
      ),
    ).toBeCloseTo(0.3)
  })
})
