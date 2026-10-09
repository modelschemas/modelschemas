import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { provider as cnProvider } from './adapters/kimi-code-plan-cn.ts'
import { provider as globalProvider } from './adapters/kimi-code-plan-global.ts'
import { KIMI_CODE_MODELS_URL } from './kimi-code-docs.ts'

vi.mock('./model-facts.ts', () => ({
  cachedDocs: (_kv: unknown, _url: string, load: () => Promise<unknown>) =>
    load(),
}))
const html = readFileSync(
  new URL('./fixtures/kimi-code-models.html.txt', import.meta.url),
  'utf8',
)
afterEach(() => vi.unstubAllGlobals())

describe('Kimi Coding regional adapters', () => {
  it('loads shared native docs for both documented regions and never borrows a spec', async () => {
    const urls: Array<string> = []
    vi.stubGlobal('fetch', (url: string) => {
      urls.push(url)
      if (url !== KIMI_CODE_MODELS_URL)
        throw new Error(`unexpected source ${url}`)
      return Promise.resolve(new Response(html))
    })
    const cn = cnProvider
    const global = globalProvider
    expect((await cn.listModels({})).models).toEqual(
      (await global.listModels({})).models,
    )
    expect((await cn.fetchSpec({})).skipped).toContain(
      'no sourced request/response schema',
    )
    expect((await global.fetchSpec({})).skipped).toContain(
      'no sourced request/response schema',
    )
    expect(urls).toEqual(Array(4).fill(KIMI_CODE_MODELS_URL))
    const models = (await cn.listModels({})).models
    expect(
      models.every(
        (model) =>
          model.pricing === null && model.absent?.pricing === 'cleared',
      ),
    ).toBe(true)
    const spec = await cn.fetchSpec({})
    expect(spec.sources).toHaveLength(1)
    expect(spec.sources[0]?.url).toBe(KIMI_CODE_MODELS_URL)
    expect(spec.sources[0]?.hash).toMatch(/^[a-f0-9]{64}$/)
  })
  it('rejects malformed native docs during both listing and spec refresh', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(new Response('<html>missing model table</html>')),
    )
    const provider = cnProvider
    await expect(provider.listModels({})).rejects.toThrow()
    await expect(provider.fetchSpec({})).rejects.toThrow()
  })
  it('fails native source fetches instead of returning an empty successful catalog', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(new Response('upstream unavailable', { status: 503 })),
    )
    const provider = cnProvider
    await expect(provider.listModels({})).rejects.toThrow(/503/)
    await expect(provider.fetchSpec({})).rejects.toThrow(/503/)
  })
})
