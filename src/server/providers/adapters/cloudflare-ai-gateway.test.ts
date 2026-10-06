import { afterEach, describe, expect, it } from 'vitest'

import {
  CATALOG_URL,
  SPEC_SKIP,
  catalogPageUrls,
  parseGatewayModelPage,
  provider,
} from './cloudflare-ai-gateway.ts'

const CATALOG_MARKDOWN = `${CATALOG_URL}index.md`

/** Excerpt of developers.cloudflare.com/ai/models/ (2026-10-06). */
const INDEX = `
[glm](https://developers.cloudflare.com/ai/models/@cf/zai-org/glm-5.3/)
[fable](https://developers.cloudflare.com/ai/models/anthropic/claude-fable-5/)
[seedance](https://developers.cloudflare.com/ai/models/bytedance/seedance-2.5/)
[socket](https://developers.cloudflare.com/ai/models/typesafe/live-socket/)
`

const FABLE = `
# Claude Fable 5

Text Generation • Anthropic

\`anthropic/claude-fable-5\`

| Model Info | |
| --- | --- |
| Context Window [ ↗](https://developers.cloudflare.com/workers-ai/platform/glossary/) | 1,000,000 tokens |
| Pricing | <ul><li>Input (per 1M tokens)$10.00</li><li>Output (per 1M tokens)$50.00</li><li>Cached input (per 1M tokens)$1.00</li><li>Cache creation (per 1M tokens)$12.50</li></ul> |

## Usage

\`anthropic/claude-fable-5\` costs $0.01 in this example.
`

const SEEDANCE = `
# Seedance 2.5

Text-to-Video • ByteDance

\`bytedance/seedance-2.5\`

| Pricing | <ul><li>Default (per second)$0.2312</li><li>@720p video input (per second)$0.9676</li></ul> |
`

const SOCKET = `
# Live socket

websocket • TypeSafe

\`typesafe/live-socket\`

| Pricing | <ul><li>Input (per 1M tokens)$1.00</li><li>Output (per 1M tokens)$2.00</li><li>Input >200k (per 1M)$1.50</li></ul> |
`

const PAGES: Record<string, string> = {
  [`${CATALOG_URL}anthropic/claude-fable-5/index.md`]: FABLE,
  [`${CATALOG_URL}bytedance/seedance-2.5/index.md`]: SEEDANCE,
  [`${CATALOG_URL}typesafe/live-socket/index.md`]: SOCKET,
}

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('cloudflare-ai-gateway', () => {
  it('lists gateway pages and skips Workers AI links', () => {
    expect(catalogPageUrls(INDEX)).toEqual([
      `${CATALOG_URL}anthropic/claude-fable-5/`,
      `${CATALOG_URL}bytedance/seedance-2.5/`,
      `${CATALOG_URL}typesafe/live-socket/`,
    ])
  })

  it('prices per-1M tokens and leaves other units null', () => {
    const source = {
      url: `${CATALOG_URL}anthropic/claude-fable-5/`,
      hash: 'abc',
      extractedAt: '2026-10-06T00:00:00.000Z',
    }
    expect(parseGatewayModelPage(FABLE, source.url, source)).toMatchObject({
      rawId: 'anthropic/claude-fable-5',
      displayName: 'Claude Fable 5',
      activity: 'chat',
      contextWindow: 1_000_000,
      pricing: {
        tables: {
          rate: {
            base: {
              input_tokens: 10 / 1_000_000,
              output_tokens: 50 / 1_000_000,
              cache_read_tokens: 1 / 1_000_000,
              cache_write_tokens: 12.5 / 1_000_000,
            },
          },
        },
      },
    })
    expect(
      parseGatewayModelPage(
        SEEDANCE,
        `${CATALOG_URL}bytedance/seedance-2.5/`,
        source,
      ),
    ).toMatchObject({
      rawId: 'bytedance/seedance-2.5',
      activity: 'video',
      pricing: null,
    })
    expect(
      parseGatewayModelPage(
        SOCKET,
        `${CATALOG_URL}typesafe/live-socket/`,
        source,
      ),
    ).toMatchObject({
      rawId: 'typesafe/live-socket',
      activity: null,
      pricing: null,
    })
  })

  it('lists catalog pages and does not fetch Workers AI or an aggregator', async () => {
    const urls: Array<string> = []
    globalThis.fetch = ((url: string) => {
      urls.push(String(url))
      const body = String(url) === CATALOG_MARKDOWN ? INDEX : PAGES[String(url)]
      if (body === undefined) {
        return Promise.reject(new Error(`unexpected fetch: ${String(url)}`))
      }
      return Promise.resolve(new Response(body))
    }) as typeof fetch

    const listed = await provider.listModels({})
    const spec = await provider.fetchSpec({})

    expect(listed.models.map((model) => model.rawId)).toEqual([
      'anthropic/claude-fable-5',
      'bytedance/seedance-2.5',
      'typesafe/live-socket',
    ])
    expect(listed.models[0]?.pricing).toMatchObject({
      source: { url: `${CATALOG_URL}anthropic/claude-fable-5/` },
    })
    expect(listed.models[1]).toMatchObject({ activity: 'video', pricing: null })
    expect(spec.skipped).toBe(SPEC_SKIP)
    expect(spec.specs).toEqual([])
    expect(urls).toEqual([
      CATALOG_MARKDOWN,
      `${CATALOG_URL}anthropic/claude-fable-5/index.md`,
      `${CATALOG_URL}bytedance/seedance-2.5/index.md`,
      `${CATALOG_URL}typesafe/live-socket/index.md`,
    ])
    expect(provider.modelsEndpoint).toBe(CATALOG_URL)
  })

  it('throws when the index lists no gateway ids', async () => {
    globalThis.fetch = () => Promise.resolve(new Response('no models here'))
    await expect(provider.listModels({})).rejects.toThrow(
      'listed no gateway ids',
    )
  })

  it('throws when two pages publish the same id', async () => {
    globalThis.fetch = ((url: string) => {
      if (String(url) === CATALOG_MARKDOWN) {
        return Promise.resolve(
          new Response(`
${CATALOG_URL}anthropic/claude-fable-5/
${CATALOG_URL}anthropic/claude-fable-5-alias/
`),
        )
      }
      return Promise.resolve(new Response(FABLE))
    }) as typeof fetch
    await expect(provider.listModels({})).rejects.toThrow(
      'duplicate model id anthropic/claude-fable-5',
    )
  })
})
