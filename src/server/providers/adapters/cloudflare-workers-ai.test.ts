import { afterEach, describe, expect, it } from 'vitest'

import { provider, WORKERS_AI_MODELS_URL } from './cloudflare-workers-ai.ts'

/** Excerpt of developers.cloudflare.com/workers-ai/models/ (2026-10-04). */
const FIXTURE = `
<div data-model-id="@cf/zai-org/glm-5.3" data-model-label="glm-5.3" data-model-task="Text Generation" data-model-context="1048576" data-model-pricing="Input (per 1M tokens): $1.40
Output (per 1M tokens): $4.40
Cached input (per 1M tokens): $0.26"></div>
<div data-model-id="@cf/deepgram/aura-1" data-model-label="aura-1" data-model-task="Text-to-Speech" data-model-pricing="per 1k characters: $0.015"></div>
<div data-model-id="@cf/black-forest-labs/flux-1-schnell" data-model-label="flux-1-schnell" data-model-task="Text-to-Image"></div>
`

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('cloudflare-workers-ai', () => {
  it('lists catalog cards and prices only per-1M input and output', async () => {
    const urls: Array<string> = []
    globalThis.fetch = ((url: string) => {
      urls.push(String(url))
      if (String(url) === WORKERS_AI_MODELS_URL) {
        return Promise.resolve(new Response(FIXTURE))
      }
      return Promise.reject(new Error(`unexpected fetch: ${String(url)}`))
    }) as typeof fetch

    const listed = await provider.listModels({})
    const spec = await provider.fetchSpec({})
    const glm = listed.models.find(
      (model) => model.rawId === '@cf/zai-org/glm-5.3',
    )
    const aura = listed.models.find(
      (model) => model.rawId === '@cf/deepgram/aura-1',
    )

    expect(listed.models.map((model) => model.rawId)).toEqual([
      '@cf/zai-org/glm-5.3',
      '@cf/deepgram/aura-1',
      '@cf/black-forest-labs/flux-1-schnell',
    ])
    expect(glm).toMatchObject({
      activity: 'chat',
      contextWindow: 1048576,
      displayName: 'glm-5.3',
    })
    expect(glm?.pricing).toMatchObject({
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
    expect(aura).toMatchObject({ activity: 'audio', pricing: null })
    expect(listed.models[2]).toMatchObject({ activity: 'image', pricing: null })
    expect(spec.skipped).toContain('skipped')
    expect(urls).toEqual([WORKERS_AI_MODELS_URL])
  })
})
