import { price } from '@modelschemas/rate-card'
import type { RateCard } from '@modelschemas/rate-card'
import { OPENCODE_CATALOG_URL } from '../opencode-catalog.ts'
import { OPENCODE_PRICING_URL } from '../opencode-pricing.ts'
import { OPENCODE_ROUTE_DOCS_URL } from '../opencode-routes.ts'

import { afterEach, describe, expect, it } from 'vitest'

import { OPENCODE_MODELS_URL, provider } from './opencode.ts'

/** Excerpt-shaped listing. Ids are fixtures, not a live snapshot. */
const LISTING = {
  object: 'list',
  data: [
    'opus',
    'gpt',
    'gemini',
    'qwen',
    'pickle',
    'unlisted',
    'mistral',
    'jev',
  ].map((id) => ({ id, object: 'model', owned_by: 'opencode' })),
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
      },
      gpt: {
        id: 'gpt',
        name: 'GPT',
        provider: { npm: '@ai-sdk/openai' },
      },
      gemini: {
        id: 'gemini',
        name: 'Gemini',
        provider: { npm: '@ai-sdk/google' },
      },
      qwen: {
        id: 'qwen',
        name: 'Qwen',
      },
      pickle: {
        id: 'pickle',
        name: 'Pickle',
      },
      mistral: {
        id: 'mistral',
        name: 'Mistral',
        provider: { npm: '@ai-sdk/mistral' },
      },
    },
  },
}

/** Console page excerpt: prices `jev`, an id models.dev has no record of, and not `qwen`. */
const PAGE = `## Endpoints

| Model   | Model ID | Endpoint | AI SDK Package |
| ------- | -------- | -------- | -------------- |
| Opus    | opus     | -        | -              |
| GPT     | gpt      | -        | -              |
| Gemini  | gemini   | -        | -              |
| Pickle  | pickle   | -        | -              |
| Mistral | mistral  | -        | -              |
| Jev     | jev      | -        | -              |

## Pricing

| Model               | Input  | Output | Cached Read | Cached Write |
| ------------------- | ------ | ------ | ----------- | ------------ |
| Opus                | $4.00  | $20.00 | $0.20       | $5.00        |
| GPT (≤ 272K tokens) | $5.00  | $30.00 | $0.50       | -            |
| GPT (> 272K tokens) | $10.00 | $45.00 | $1.00       | -            |
| Gemini              | $2.00  | $12.00 | $0.20       | -            |
| Pickle              | Free   | Free   | Free        | -            |
| Mistral             | $1.00  | $2.00  | -           | -            |
| Jev                 | $0.042 | Free   | -           | -            |
`

/** inference.mdx Endpoints table, listing the paths CATALOG's api yields. */
const ROUTE_DOCS = `# Inference API

## Endpoints

| API       | Path                                               |
| --------- | -------------------------------------------------- |
| Chat      | \`/inference/v1/chat/completions\`                   |
| Responses | \`/inference/v1/responses\`                          |
| Messages  | \`/inference/v1/messages\`                           |
| Gemini    | \`/inference/v1/models/<model>:generateContent\`     |
`

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function serve(catalog: unknown = CATALOG, page = PAGE) {
  const urls: Array<string> = []
  globalThis.fetch = ((url: string) => {
    urls.push(String(url))
    if (String(url) === OPENCODE_MODELS_URL) {
      return Promise.resolve(new Response(JSON.stringify(LISTING)))
    }
    if (String(url) === OPENCODE_CATALOG_URL) {
      return Promise.resolve(new Response(JSON.stringify(catalog)))
    }
    if (String(url) === OPENCODE_PRICING_URL) {
      return Promise.resolve(new Response(page))
    }
    if (String(url) === OPENCODE_ROUTE_DOCS_URL) {
      return Promise.resolve(new Response(ROUTE_DOCS))
    }
    return Promise.reject(new Error(`unexpected fetch: ${String(url)}`))
  }) as typeof fetch
  return urls
}

type Card = { tables: { rate: Record<string, Record<string, number>> } }

describe('opencode', () => {
  it('reads routes from the catalog and prices from the console page', async () => {
    const urls = serve()
    const { models } = await provider.listModels({})
    const byId = Object.fromEntries(models.map((m) => [m.rawId, m]))

    expect(models.map((m) => m.rawId)).toEqual(LISTING.data.map((r) => r.id))
    expect(urls.some((url) => url.includes('opencode.ai/docs/'))).toBe(false)

    expect(byId.opus).toMatchObject({
      displayName: 'Opus',
      activity: 'chat',
      schemaEndpointId: 'inference/v1/messages',
      contextWindow: 1234,
      factSources: {
        pricing: {
          derivation: 'docs-derived',
          sourceUrl: OPENCODE_PRICING_URL,
        },
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
    expect(byId.gemini?.schemaEndpointId).toBe(
      'inference/v1/models/gemini:generateContent',
    )
    expect(byId.qwen?.schemaEndpointId).toBe('inference/v1/chat/completions')
    expect(byId.qwen?.factSources?.schemaEndpointId?.path).toBe('opencode.npm')
    // The page does not price qwen: a stored card is cleared.
    expect(byId.qwen?.pricing).toBeNull()
    expect(byId.qwen?.absent).toEqual({
      releasedAt: 'cleared',
      pricing: 'cleared',
    })
    // jev has no models.dev record but the page prices it.
    expect(byId.jev?.absent).toEqual({ releasedAt: 'cleared' })
    expect(
      price(
        byId.jev!.pricing as RateCard,
        {},
        { input_tokens: 1_000_000, output_tokens: 1_000_000 },
      ),
    ).toBeCloseTo(0.042)

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
    expect(source.url).toBe(OPENCODE_ROUTE_DOCS_URL)
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

  it('prices a model that was free once the page quotes a rate', async () => {
    serve(
      CATALOG,
      PAGE.replace(
        '| Pickle              | Free   | Free   | Free        |',
        '| Pickle              | $0.10  | $0.20  | $0.01       |',
      ),
    )
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

  it('keeps stored prices when the page fails, and still polls', async () => {
    serve(CATALOG, '## Pricing\n\nmoved\n')
    const result = await provider.listModels({})
    expect(result.docsFailures).toMatchObject({ failed: 1 })
    for (const model of result.models) {
      expect(model.pricing ?? null).toBeNull()
      expect(model.absent?.pricing).toBe('unavailable')
    }
  })
})
