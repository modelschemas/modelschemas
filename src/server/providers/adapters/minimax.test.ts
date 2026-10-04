import { afterEach, describe, expect, it } from 'vitest'

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

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('minimax', () => {
  it('lists linked model ids and leaves prices null', async () => {
    const urls: Array<string> = []
    globalThis.fetch = ((url: string) => {
      urls.push(String(url))
      if (String(url) === MINIMAX_MODELS_URL) {
        return Promise.resolve(new Response(FIXTURE))
      }
      return Promise.reject(new Error(`unexpected fetch: ${String(url)}`))
    }) as typeof fetch

    const listed = await provider.listModels({})
    const spec = await provider.fetchSpec({})

    expect(listed.models).toEqual([
      { rawId: 'MiniMax-M2.7', activity: 'chat', pricing: null },
      { rawId: 'MiniMax-M3', activity: 'chat', pricing: null },
      { rawId: 'speech-2.8-hd', activity: 'audio', pricing: null },
      { rawId: 'speech-2.8-turbo', activity: 'audio', pricing: null },
    ])
    expect(
      listed.models
        .filter((model) => model.rawId.startsWith('speech-'))
        .every((model) => model.activity === 'audio'),
    ).toBe(true)
    expect(listed.models.some((model) => model.rawId === 'fal.ai')).toBe(false)
    expect(listed.models.some((model) => model.rawId === 'MiniMax-H3')).toBe(
      false,
    )
    expect(listed.models.some((model) => model.rawId === 'MiniMax H3')).toBe(
      false,
    )
    expect(spec.skipped).toContain('skipped')
    expect(urls).toEqual([MINIMAX_MODELS_URL])
  })
})
