import { afterEach, describe, expect, it } from 'vitest'

import {
  MINIMAX_MAX_COMPLETION_TOKENS,
  MINIMAX_PRICING_PAGE,
  MINIMAX_SDK_PAGE,
} from '../fixtures/minimax-docs.ts'
import {
  MINIMAX_CHAT_SPEC_URL,
  MINIMAX_MESSAGES_SPEC_URL,
  MINIMAX_PRICING_URL,
  MINIMAX_SDK_URL,
} from '../minimax-docs.ts'
import { MINIMAX_MODELS_URL, provider } from './minimax.ts'

/** Excerpt of platform.minimax.io models-intro.md (2026-10-04). */
const FIXTURE = `
### Language

| **Models** | **Description** |
| :- | :- |
| [MiniMax-M2.7](/docs/api-reference/text-anthropic-api) | Beginning the journey |
| <a href="/docs/api-reference/text-anthropic-api">MiniMax-M3</a> | Frontier |

### Video

| **Models** | **Description** |
| :- | :- |
| [MiniMax H3](/docs/api-reference/video-generation-v2-create) | Next-gen open general-purpose multimodal video model |
| [MiniMax H3 Max](/docs/api-reference/video-generation-v2-create) | High-speed video model post-trained by [fal.ai](https://fal.ai/) on MiniMax H3 |

### Audio

| **Models** | **Description** |
| :- | :- |
| [speech-2.8-hd](/docs/api-reference/speech-t2a-http) | Ultra-realistic quality featuring sound tags |
| [speech-2.8-turbo](/docs/api-reference/speech-t2a-http) | Seamless speed meets natural flow |
`

const CHAT_SPEC = {
  openapi: '3.1.0',
  paths: { '/v1/chat/completions': { post: {} } },
  components: {
    schemas: {
      ChatCompletionReq: {
        properties: {
          max_completion_tokens: {
            type: 'integer',
            description: MINIMAX_MAX_COMPLETION_TOKENS,
          },
        },
      },
    },
  },
}

const PAGES: Record<string, string> = {
  [MINIMAX_MODELS_URL]: FIXTURE,
  [MINIMAX_SDK_URL]: MINIMAX_SDK_PAGE,
  [MINIMAX_PRICING_URL]: MINIMAX_PRICING_PAGE,
  [MINIMAX_CHAT_SPEC_URL]: JSON.stringify(CHAT_SPEC),
  [MINIMAX_MESSAGES_SPEC_URL]: JSON.stringify({
    openapi: '3.1.0',
    paths: { '/anthropic/v1/messages': { post: {} } },
  }),
}

const originalFetch = globalThis.fetch

function mockFetch(pages: Record<string, string>): void {
  globalThis.fetch = ((url: string) => {
    const page = pages[String(url)]
    return page === undefined
      ? Promise.reject(new Error(`unexpected fetch: ${String(url)}`))
      : Promise.resolve(new Response(page))
  }) as typeof fetch
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('minimax', () => {
  it('lists linked model ids and fills chat rows from the docs pages', async () => {
    mockFetch(PAGES)

    const listed = await provider.listModels({})

    expect(listed.models.map((model) => [model.rawId, model.activity])).toEqual(
      [
        ['MiniMax-M2.7', 'chat'],
        ['MiniMax-M3', 'chat'],
        ['speech-2.8-hd', 'audio'],
        ['speech-2.8-turbo', 'audio'],
      ],
    )
    const m3 = listed.models.find((model) => model.rawId === 'MiniMax-M3')
    expect(m3).toMatchObject({
      contextWindow: 1_000_000,
      maxOutput: 524_288,
      modalities: { input: ['text', 'image', 'video'], output: ['text'] },
      reasoning: { mode: 'adaptive', mandatory: false },
      pricing: {
        tables: { rate: { base: { input_tokens: 0.3 / 1e6 } } },
        source: { url: MINIMAX_PRICING_URL },
      },
      factSources: {
        contextWindow: {
          derivation: 'docs-derived',
          sourceUrl: MINIMAX_SDK_URL,
        },
        maxOutput: { sourceUrl: MINIMAX_CHAT_SPEC_URL },
        modalities: { sourceUrl: MINIMAX_SDK_URL },
        reasoning: { sourceUrl: MINIMAX_SDK_URL },
        pricing: { sourceUrl: MINIMAX_PRICING_URL },
      },
    })
    // Speech rows stay as listed: the chat pages say nothing about them.
    expect(
      listed.models.find((model) => model.rawId === 'speech-2.8-hd'),
    ).toEqual({ rawId: 'speech-2.8-hd', activity: 'audio', pricing: null })
    expect(listed.models.some((model) => model.rawId === 'fal.ai')).toBe(false)
    expect(listed.models.some((model) => model.rawId === 'MiniMax H3')).toBe(
      false,
    )
  })

  it('throws when a docs page parses nothing', async () => {
    mockFetch({ ...PAGES, [MINIMAX_PRICING_URL]: '# Pay as You Go\n' })
    await expect(provider.listModels({})).rejects.toThrow(
      'minimax pricing page: parsed 0 model rows',
    )
  })

  it('syncs both chat documents and binds chat rows to chat completions', async () => {
    mockFetch(PAGES)

    const spec = await provider.fetchSpec({})

    expect(spec.sources.map((source) => source.url)).toEqual([
      MINIMAX_CHAT_SPEC_URL,
      MINIMAX_MESSAGES_SPEC_URL,
    ])
    expect(spec.specs).toHaveLength(2)
    expect(provider.classify('/v1/chat/completions', {})).toBe('chat')
    expect(provider.classify('/anthropic/v1/messages', {})).toBe('chat')
    expect(
      provider.classify('/anthropic/v1/messages/count_tokens', {}),
    ).toBeNull()
    expect(
      provider.generationEndpointId?.({
        rawId: 'MiniMax-M3',
        activity: 'chat',
      }),
    ).toBe('v1/chat/completions')
    expect(
      provider.generationEndpointId?.({
        rawId: 'speech-2.8-hd',
        activity: 'audio',
      }),
    ).toBeNull()
  })
})
