import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  glmCodingProvider,
  ZAI_CODING_SOURCES,
  ZHIPU_CODING_SOURCES,
} from './glm-coding.ts'

vi.mock('./model-facts.ts', () => ({
  cachedDocs: (_kv: unknown, _url: string, load: () => Promise<unknown>) =>
    load(),
}))
afterEach(() => vi.unstubAllGlobals())
describe('Coding providers native HTTP sources', () => {
  it('reads only each own regional source and records honest schema skip hashes', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', (url: string) => {
      urls.push(url)
      const parsed = new URL(url)
      const filename = `${parsed.hostname}-${parsed.pathname.split('/').at(-1)}`
      return Promise.resolve(
        new Response(
          readFileSync(new URL(`./fixtures/${filename}.txt`, import.meta.url)),
        ),
      )
    })
    for (const [locale, sources] of [
      ['en', ZAI_CODING_SOURCES],
      ['zh', ZHIPU_CODING_SOURCES],
    ] as const) {
      const provider = glmCodingProvider(
        `native-${locale}`,
        'Native coding',
        locale,
        sources,
      )
      const { models } = await provider.listModels({})
      expect(models).toHaveLength(2)
      for (const model of models) {
        expect(model.requestMap?.replayReasoningContent).toBe(true)
        expect(model.factSources?.requestMap?.sourceUrl).toBe(sources.thinking)
        expect(
          model.factSources?.requestMapFields?.replayReasoningContent
            ?.sourceUrl,
        ).toBe(sources.replay)
      }
      const spec = await provider.fetchSpec({})
      expect(spec.specs).toEqual([])
      expect(spec.sources.map((source) => source.url)).toEqual([
        sources.overview,
        sources.latest,
        sources.thinking,
        sources.replay,
      ])
      for (const source of spec.sources)
        expect(source.hash).toMatch(/^[a-f0-9]{64}$/)
      expect(spec.skipped).toContain(
        'no complete Coding request/response schema',
      )
    }
    expect(urls).toHaveLength(16)
    expect(
      urls.every((url) =>
        [
          ZAI_CODING_SOURCES.overview,
          ZAI_CODING_SOURCES.latest,
          ZAI_CODING_SOURCES.thinking,
          ZAI_CODING_SOURCES.replay,
          ZHIPU_CODING_SOURCES.overview,
          ZHIPU_CODING_SOURCES.latest,
          ZHIPU_CODING_SOURCES.thinking,
          ZHIPU_CODING_SOURCES.replay,
        ].includes(url),
      ),
    ).toBe(true)
  })
  it('fails HTTP and malformed native evidence for catalog and spec refresh', async () => {
    const provider = glmCodingProvider(
      'native-en',
      'Native coding',
      'en',
      ZAI_CODING_SOURCES,
    )
    vi.stubGlobal('fetch', () =>
      Promise.resolve(new Response('unavailable', { status: 503 })),
    )
    await expect(provider.listModels({})).rejects.toThrow(/503/)
    await expect(provider.fetchSpec({})).rejects.toThrow(/503/)
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('changed docs')))
    await expect(provider.listModels({})).rejects.toThrow(
      'native overview document heading',
    )
    await expect(provider.fetchSpec({})).rejects.toThrow(
      'native overview document heading',
    )
  })
})
