import { afterEach, describe, expect, it } from 'vitest'

import { MINIMAX_CN_MODELS_URL, provider } from './minimax-cn.ts'

/** Excerpt of platform.minimaxi.com models-intro.md (2026-10-04). */
const FIXTURE = `
### 语言模型

| **模型名称** | **介绍** |
| :- | :- |
| [MiniMax-M2.7](/docs/api-reference/text-anthropic-api) | 开启模型的自我迭代 |
| <a href="/docs/api-reference/text-anthropic-api">MiniMax-M3</a> | Frontier |

### 视频模型

| **模型名称** | **介绍** |
| :- | :- |
| [MiniMax H3](/docs/api-reference/video-generation-v2-create) | 新一代开放通用多模态视频模型 |
| [MiniMax H3 Max](/docs/api-reference/video-generation-v2-create) | 由 [fal.ai](https://fal.ai/) 基于 MiniMax H3 后训练的极速视频生成模型 |

### 语音模型

| **模型名称** | **介绍** |
| :- | :- |
| [Speech-2.8-HD](/docs/api-reference/speech-t2a-http) | 新一代语音 HD 模型 |
`

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('minimax-cn', () => {
  it('lists linked model ids and leaves prices null', async () => {
    const urls: Array<string> = []
    globalThis.fetch = ((url: string) => {
      urls.push(String(url))
      if (String(url) === MINIMAX_CN_MODELS_URL) {
        return Promise.resolve(new Response(FIXTURE))
      }
      return Promise.reject(new Error(`unexpected fetch: ${String(url)}`))
    }) as typeof fetch

    const listed = await provider.listModels({})
    const spec = await provider.fetchSpec({})

    expect(listed.models).toEqual([
      { rawId: 'MiniMax-M2.7', activity: 'chat', pricing: null },
      { rawId: 'MiniMax-M3', activity: 'chat', pricing: null },
      { rawId: 'Speech-2.8-HD', activity: 'audio', pricing: null },
    ])
    expect(listed.models.some((model) => model.rawId === 'fal.ai')).toBe(false)
    expect(listed.models.some((model) => model.rawId === 'MiniMax-H3')).toBe(
      false,
    )
    expect(listed.models.some((model) => model.rawId === 'MiniMax H3')).toBe(
      false,
    )
    expect(spec.skipped).toContain('skipped')
    expect(urls).toEqual([MINIMAX_CN_MODELS_URL])
  })
})
