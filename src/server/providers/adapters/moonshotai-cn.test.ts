import { afterEach, describe, expect, it } from 'vitest'

import { MOONSHOT_CN_PRICING_URL, provider } from './moonshotai-cn.ts'

/** Excerpt of platform.moonshot.cn/docs/pricing.md (2026-10-04). Prices are yuan. */
const FIXTURE = `
rows={[
["kimi-k3", "1M tokens", "¥20.00", "¥40.00", "¥2.00", "¥20.00", "¥100.00", "1,048,576 tokens"],
["kimi-k2.6", "1M tokens", "¥1.10", "¥6.50", "¥27.00", "262,144 tokens"],
]}
`

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('moonshotai-cn', () => {
  it('lists CN model ids and does not store yuan as USD', async () => {
    const urls: Array<string> = []
    globalThis.fetch = ((url: string) => {
      urls.push(String(url))
      if (String(url) === MOONSHOT_CN_PRICING_URL) {
        return Promise.resolve(new Response(FIXTURE))
      }
      return Promise.reject(new Error(`unexpected fetch: ${String(url)}`))
    }) as typeof fetch

    const listed = await provider.listModels({})
    const spec = await provider.fetchSpec({})

    expect(listed.models).toEqual([
      { rawId: 'kimi-k3', contextWindow: 1048576, pricing: null },
      { rawId: 'kimi-k2.6', contextWindow: 262144, pricing: null },
    ])
    expect(spec.skipped).toContain('skipped')
    expect(urls).toEqual([MOONSHOT_CN_PRICING_URL])
  })
})
