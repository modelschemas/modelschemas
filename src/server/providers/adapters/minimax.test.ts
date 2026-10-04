import { afterEach, describe, expect, it } from 'vitest'

import { MINIMAX_MODELS_URL, provider } from './minimax.ts'

/** Excerpt of platform.minimax.io models-intro.md (2026-10-04). */
const FIXTURE = `
### Language

| Models | Description |
| [MiniMax-M2.7](/docs/api-reference/text-anthropic-api) | coding model |
| <a href="/docs/api-reference/text-anthropic-api">MiniMax-M3</a> | frontier |

### Video

| [MiniMax H3](/docs/api-reference/video-generation-v2-create) | display name with a space |

### Speech

| [Speech-2.8-HD](/docs/api-reference/speech-t2a-http) | speech |
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
      { rawId: 'Speech-2.8-HD', activity: 'audio', pricing: null },
    ])
    expect(spec.skipped).toContain('skipped')
    expect(urls).toEqual([MINIMAX_MODELS_URL])
  })
})
