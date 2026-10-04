import { afterEach, describe, expect, it } from 'vitest'

import { NVIDIA_MODELS_URL, provider } from './nvidia.ts'

/** Excerpt of https://integrate.api.nvidia.com/v1/models (2026-10-04). */
const FIXTURE = {
  object: 'list',
  data: [
    {
      id: '01-ai/yi-large',
      object: 'model',
      created: 735790403,
      owned_by: 'nvidia',
    },
  ],
}

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('nvidia', () => {
  it('lists published ids and leaves prices null', async () => {
    const urls: Array<string> = []
    globalThis.fetch = ((url: string) => {
      urls.push(String(url))
      if (String(url) === NVIDIA_MODELS_URL) {
        return Promise.resolve(new Response(JSON.stringify(FIXTURE)))
      }
      return Promise.reject(new Error(`unexpected fetch: ${String(url)}`))
    }) as typeof fetch

    const listed = await provider.listModels({})
    const spec = await provider.fetchSpec({})

    expect(listed.models).toEqual([
      { rawId: '01-ai/yi-large', releasedAt: 735790403, pricing: null },
    ])
    expect(spec.skipped).toContain('skipped')
    expect(urls).toEqual([NVIDIA_MODELS_URL])
  })
})
