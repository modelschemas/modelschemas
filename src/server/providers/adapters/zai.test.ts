import { afterEach, describe, expect, it } from 'vitest'

import { provider, ZAI_OPENAPI_URL, ZAI_PRICING_URL } from './zai.ts'

/** Enum excerpt of https://docs.z.ai/openapi.json (2026-10-04). */
const SPEC = {
  openapi: '3.0.1',
  info: { title: 'Z.AI API', version: '1' },
  paths: {
    '/paas/v4/chat/completions': { post: { responses: { '200': {} } } },
    '/paas/v4/images/generations': { post: {} },
    '/paas/v4/tokenizer': { post: {} },
  },
  components: {
    schemas: {
      ChatModel: { enum: ['glm-5.3', 'glm-5.3-flash', 'glm-image'] },
    },
  },
}

/** Excerpt of https://docs.z.ai/guides/overview/pricing.md (2026-10-04). */
const PRICING = `
Prices per 1M tokens.

| Model | Input | Cached Input | Cached Input Storage | Output |
| :- | :- | :- | :- | :- |
| GLM-5.3 | $1.4 | $0.26 | Limited-time Free | $4.4 |
| GLM-5.3-Flash | $0.15 | $0.03 | Limited-time Free | $0.50 |
| Not-A-Model | $9 | $1 | - | $9 |

### Image Generation Models

Prices per image.

| Model | Price |
| GLM-Image | $0.015 |
`

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('zai', () => {
  it('lists OpenAPI model ids and per-1M prices that match those ids', async () => {
    const urls: Array<string> = []
    globalThis.fetch = ((url: string) => {
      urls.push(String(url))
      if (String(url) === ZAI_OPENAPI_URL) {
        return Promise.resolve(new Response(JSON.stringify(SPEC)))
      }
      if (String(url) === ZAI_PRICING_URL) {
        return Promise.resolve(new Response(PRICING))
      }
      return Promise.reject(new Error(`unexpected fetch: ${String(url)}`))
    }) as typeof fetch

    const listed = await provider.listModels({})
    const spec = await provider.fetchSpec({})
    const byId = new Map(listed.models.map((model) => [model.rawId, model]))

    expect(listed.models.map((model) => model.rawId)).toEqual([
      'glm-5.3',
      'glm-5.3-flash',
      'glm-image',
    ])
    expect(byId.get('glm-5.3')?.pricing).toMatchObject({
      tables: {
        rate: {
          base: {
            input_tokens: 1.4 / 1_000_000,
            output_tokens: 4.4 / 1_000_000,
            cache_read_tokens: 0.26 / 1_000_000,
          },
        },
      },
    })
    expect(byId.get('glm-5.3-flash')?.pricing).toMatchObject({
      tables: {
        rate: {
          base: {
            input_tokens: 0.15 / 1_000_000,
            output_tokens: 0.5 / 1_000_000,
          },
        },
      },
    })
    expect(byId.get('glm-image')?.pricing).toBeNull()
    expect(listed.models.some((model) => model.rawId === 'not-a-model')).toBe(
      false,
    )
    expect(spec.specs).toHaveLength(1)
    expect(spec.sources[0]?.url).toBe(ZAI_OPENAPI_URL)
    expect(provider.classify('/paas/v4/chat/completions', {})).toBe('chat')
    expect(provider.classify('/paas/v4/images/generations', {})).toBe('image')
    expect(provider.classify('/paas/v4/tokenizer', {})).toBeNull()
    expect(urls).toEqual([ZAI_OPENAPI_URL, ZAI_PRICING_URL, ZAI_OPENAPI_URL])
    expect(provider.classify('/paas/v4/videos/generations', {})).toBe('video')
    expect(provider.classify('/paas/v4/audio/speech', {})).toBe('audio')
  })
})
