import { afterEach, describe, expect, it } from 'vitest'

import { OPENCODE_GO_MODELS_URL, provider } from './opencode-go.ts'

/** Excerpt of https://opencode.ai/zen/go/v1/models (2026-10-04). */
const FIXTURE = {
  object: 'list',
  data: [
    {
      id: 'minimax-m3',
      object: 'model',
      created: 1791102623,
      owned_by: 'opencode-go',
    },
  ],
}

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('opencode-go', () => {
  it('lists published ids and leaves prices null', async () => {
    const urls: Array<string> = []
    globalThis.fetch = ((url: string) => {
      urls.push(String(url))
      if (String(url) === OPENCODE_GO_MODELS_URL) {
        return Promise.resolve(new Response(JSON.stringify(FIXTURE)))
      }
      return Promise.reject(new Error(`unexpected fetch: ${String(url)}`))
    }) as typeof fetch

    const listed = await provider.listModels({})
    const spec = await provider.fetchSpec({})

    expect(listed.models).toEqual([
      { rawId: 'minimax-m3', releasedAt: 1791102623, pricing: null },
    ])
    expect(spec.skipped).toContain('skipped')
    expect(urls).toEqual([OPENCODE_GO_MODELS_URL])
  })
})
