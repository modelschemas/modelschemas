import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { provider } from './dashscope-cn.ts'

vi.mock('./model-facts.ts', () => ({
  cachedDocs: (_kv: unknown, _url: string, load: () => Promise<unknown>) =>
    load(),
}))
afterEach(() => vi.unstubAllGlobals())
describe('DashScope CN public native adapter', () => {
  it('needs no international key and uses only owned Chinese sources', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', (url: string) => {
      urls.push(url)
      expect(url).toMatch(/^https:\/\/help\.aliyun\.com\/zh\/model-studio\//)
      const file = new URL(url).pathname.split('/').at(-1)
      return Promise.resolve(
        new Response(
          readFileSync(
            new URL(`./fixtures/dashscope-cn/${file}.txt`, import.meta.url),
          ),
        ),
      )
    })
    const listed = await provider.listModels({})
    expect(listed.models.length).toBeGreaterThan(400)
    expect(
      listed.models.find((model) => model.rawId === 'qwen-flash')?.pricing,
    ).not.toBeNull()
    const spec = await provider.fetchSpec({})
    expect(spec.specs).toEqual([])
    expect(spec.sources).toHaveLength(4)
    expect(
      spec.sources.every((entry) => /^[a-f0-9]{64}$/.test(entry.hash)),
    ).toBe(true)
    expect(spec.skipped).toContain('no sourced complete API body schema')
    expect(urls).toHaveLength(8)
    expect(provider.generationEndpointId).toBeUndefined()
  })
  it('does not replace failed native fetches with Intl metadata or empty catalogs', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(new Response('unavailable', { status: 503 })),
    )
    await expect(provider.listModels({})).rejects.toThrow(/503/)
    await expect(provider.fetchSpec({})).rejects.toThrow(/503/)
  })
})

it('rejects a successful wrong native page rather than retaining partial facts', async () => {
  vi.stubGlobal('fetch', (url: string) => {
    const file = new URL(url).pathname.split('/').at(-1)
    let text = readFileSync(
      new URL(`./fixtures/dashscope-cn/${file}.txt`, import.meta.url),
      'utf8',
    )
    if (file === 'qwen-flash.md')
      text = text.replace('# qwen-flash', '# unrelated')
    return Promise.resolve(new Response(text))
  })
  await expect(provider.listModels({})).rejects.toThrow(
    'malformed native source',
  )
})
