import { afterEach, describe, expect, it } from 'vitest'

import { OPENCODE_MODELS_URL, provider } from './opencode.ts'

/** Excerpt of https://opencode.ai/zen/v1/models (2026-10-04). */
const FIXTURE = {
  object: 'list',
  data: [
    {
      id: 'claude-fable-5',
      object: 'model',
      created: 1791102622,
      owned_by: 'opencode',
    },
  ],
}

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('opencode', () => {
  it('lists published ids and leaves prices null', async () => {
    const urls: Array<string> = []
    globalThis.fetch = ((url: string) => {
      urls.push(String(url))
      if (String(url) === OPENCODE_MODELS_URL) {
        return Promise.resolve(new Response(JSON.stringify(FIXTURE)))
      }
      return Promise.reject(new Error(`unexpected fetch: ${String(url)}`))
    }) as typeof fetch

    const listed = await provider.listModels({})
    const spec = await provider.fetchSpec({})

    expect(listed.models).toEqual([
      { rawId: 'claude-fable-5', releasedAt: 1791102622, pricing: null },
    ])
    expect(spec.skipped).toContain('skipped')
    expect(urls).toEqual([OPENCODE_MODELS_URL])
  })
})
