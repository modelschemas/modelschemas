import { afterEach, describe, expect, it } from 'vitest'

import { SKIP_REASON, provider } from './kimi-code-plan-cn.ts'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('kimi-code-plan-cn', () => {
  it('skips listModels and fetchSpec without calling an aggregator', async () => {
    const urls: Array<string> = []
    globalThis.fetch = ((url: string) => {
      urls.push(String(url))
      return Promise.reject(new Error(`unexpected fetch: ${String(url)}`))
    }) as typeof fetch

    const listed = await provider.listModels({})
    const spec = await provider.fetchSpec({})

    expect(listed.skipped).toBe(SKIP_REASON)
    expect(listed.models).toEqual([])
    expect(spec.skipped).toBe(SKIP_REASON)
    expect(spec.specs).toEqual([])
    expect(urls).toEqual([])
    expect(provider.modelsEndpoint).toBeUndefined()
  })
})
