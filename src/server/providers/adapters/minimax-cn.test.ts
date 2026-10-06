import { afterEach, describe, expect, it } from 'vitest'

import {
  MINIMAX_CN_MAX_COMPLETION_TOKENS,
  MINIMAX_CN_SDK_PAGE,
} from '../fixtures/minimax-docs.ts'
import { MINIMAX_CN, MINIMAX_CN_MESSAGES_SPEC_URL } from '../minimax-docs.ts'
import { MINIMAX_CN_MODELS_URL, provider } from './minimax-cn.ts'

/** Excerpt of platform.minimaxi.com models-intro.md (2026-10-04). */
const FIXTURE = `
### 语言模型

| **模型名称** | **介绍** |
| :- | :- |
| [MiniMax-M2.7](/docs/api-reference/text-anthropic-api) | 开启模型的自我迭代 |
| <a href="/docs/api-reference/text-anthropic-api">MiniMax-M3</a> | Frontier |
| [MiniMax-M3.1-Flash-Preview](/docs/api-reference/text-anthropic-api) | 思考深度可调 |
| [MiniMax-M9](/docs/api-reference/text-anthropic-api) | 文档页未列出 |

### 视频模型

| **模型名称** | **介绍** |
| :- | :- |
| [MiniMax H3](/docs/api-reference/video-generation-v2-create) | 新一代开放通用多模态视频模型 |
| [MiniMax H3 Max](/docs/api-reference/video-generation-v2-create) | 由 [fal.ai](https://fal.ai/) 基于 MiniMax H3 后训练的极速视频生成模型 |

### Audio

| **Models** | **Description** |
| :- | :- |
| [speech-2.8-hd](/docs/api-reference/speech-t2a-http) | Ultra-realistic quality featuring sound tags |
| [speech-2.8-turbo](/docs/api-reference/speech-t2a-http) | Seamless speed meets natural flow |

### 语音模型

| **模型名称** | **介绍** |
| :- | :- |
| [Speech-2.8-HD](/docs/api-reference/speech-t2a-http) | 新一代语音 HD 模型 |
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
            description: MINIMAX_CN_MAX_COMPLETION_TOKENS,
          },
        },
      },
    },
  },
}

const PAGES: Record<string, string> = {
  [MINIMAX_CN_MODELS_URL]: FIXTURE,
  [MINIMAX_CN.sdkUrl]: MINIMAX_CN_SDK_PAGE,
  [MINIMAX_CN.chatSpecUrl]: JSON.stringify(CHAT_SPEC),
  [MINIMAX_CN_MESSAGES_SPEC_URL]: JSON.stringify({
    openapi: '3.1.0',
    paths: { '/anthropic/v1/messages': { post: {} } },
  }),
}

const originalFetch = globalThis.fetch

function mockFetch(pages: Record<string, string>): Array<string> {
  const urls: Array<string> = []
  globalThis.fetch = ((url: string) => {
    urls.push(String(url))
    const page = pages[String(url)]
    return page === undefined
      ? Promise.reject(new Error(`unexpected fetch: ${String(url)}`))
      : Promise.resolve(new Response(page))
  }) as typeof fetch
  return urls
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('minimax-cn', () => {
  it('lists linked model ids and fills chat rows from the China docs pages', async () => {
    const urls = mockFetch(PAGES)

    const listed = await provider.listModels({})

    expect(listed.models.map((model) => [model.rawId, model.activity])).toEqual(
      [
        ['MiniMax-M2.7', 'chat'],
        ['MiniMax-M3', 'chat'],
        ['MiniMax-M3.1-Flash-Preview', 'chat'],
        ['MiniMax-M9', 'chat'],
        ['speech-2.8-hd', 'audio'],
        ['speech-2.8-turbo', 'audio'],
        ['Speech-2.8-HD', 'audio'],
      ],
    )
    const m3 = listed.models.find((model) => model.rawId === 'MiniMax-M3')
    expect(m3).toMatchObject({
      contextWindow: 1_000_000,
      maxOutput: 524_288,
      modalities: { input: ['text', 'image', 'video'], output: ['text'] },
      reasoning: { mode: 'adaptive', mandatory: false },
      // The pay-as-you-go page quotes yuan; rate cards are USD.
      pricing: null,
      schemaEndpointId: 'v1/chat/completions',
      factSources: {
        contextWindow: {
          derivation: 'docs-derived',
          sourceUrl: MINIMAX_CN.sdkUrl,
        },
        maxOutput: { sourceUrl: MINIMAX_CN.chatSpecUrl },
        modalities: { sourceUrl: MINIMAX_CN.sdkUrl },
        reasoning: { sourceUrl: MINIMAX_CN.sdkUrl },
      },
    })
    expect(m3?.factSources?.pricing).toBeUndefined()
    // Only the model with an effort list takes `reasoning_effort`.
    expect(m3?.capabilities).toBeUndefined()
    expect(m3?.factSources?.capabilities).toBeUndefined()
    const flash = listed.models.find(
      (model) => model.rawId === 'MiniMax-M3.1-Flash-Preview',
    )
    expect(flash?.capabilities).toEqual(['reasoning_effort'])
    expect(flash?.factSources?.capabilities).toMatchObject({
      // The chat spec is the page that names `reasoning_effort`.
      reasoning_effort: { sourceUrl: MINIMAX_CN.chatSpecUrl },
    })
    // An id the docs pages do not name gets no facts and no route.
    expect(listed.models.find((model) => model.rawId === 'MiniMax-M9')).toEqual(
      { rawId: 'MiniMax-M9', activity: 'chat', pricing: null },
    )
    expect(
      listed.models.find((model) => model.rawId === 'speech-2.8-hd'),
    ).toEqual({ rawId: 'speech-2.8-hd', activity: 'audio', pricing: null })
    expect(listed.models.some((model) => model.rawId === 'fal.ai')).toBe(false)
    expect(listed.models.some((model) => model.rawId === 'MiniMax H3')).toBe(
      false,
    )
    // Every page is the China platform's own; no pricing page is read.
    expect(urls.sort()).toEqual(
      [MINIMAX_CN_MODELS_URL, MINIMAX_CN.sdkUrl, MINIMAX_CN.chatSpecUrl].sort(),
    )
    expect(urls.every((url) => url.includes('platform.minimaxi.com'))).toBe(
      true,
    )
  })

  it('throws when a docs page parses nothing', async () => {
    mockFetch({
      ...PAGES,
      [MINIMAX_CN.sdkUrl]: '<!doctype html><title>验证</title>',
    })
    await expect(provider.listModels({})).rejects.toThrow(
      'minimax-cn context windows: parsed 0 model rows',
    )
  })

  it('syncs both China chat documents and binds only synced routes', async () => {
    mockFetch(PAGES)

    const spec = await provider.fetchSpec({})

    expect(spec.sources.map((source) => source.url)).toEqual([
      MINIMAX_CN.chatSpecUrl,
      MINIMAX_CN_MESSAGES_SPEC_URL,
    ])
    expect(spec.skipped).toBeUndefined()
    expect(provider.classify('/v1/chat/completions', {})).toBe('chat')
    expect(provider.classify('/anthropic/v1/messages', {})).toBe('chat')
    expect(
      provider.classify('/anthropic/v1/messages/count_tokens', {}),
    ).toBeNull()
    expect(provider.bindSyncedRoutesOnly).toBe(true)
    expect(provider.perModelSchemaFlags).toEqual(['reasoning_effort'])
  })

  it('refuses an HTML page served in place of a spec', async () => {
    mockFetch({
      ...PAGES,
      [MINIMAX_CN.chatSpecUrl]: '<html><body>302 Found</body></html>',
    })
    await expect(provider.fetchSpec({})).rejects.toThrow()
  })
})
