import { afterEach, expect, it, vi } from 'vitest'
import { openrouterProvider } from './openrouter.ts'
import { OPENROUTER_ADAPTIVE_GUIDES } from './openrouter-reasoning.ts'
import { sha256Text } from './types.ts'
import adaptive from './fixtures/openrouter-claude-adaptive.json'
import reasoningDocs from './fixtures/openrouter-native-toggle.json'

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubFetch(guide: () => Response) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url === adaptive.sourceUrl) return Response.json(adaptive.listing)
      if (url === reasoningDocs.sourceUrl)
        return new Response(reasoningDocs.markdown)
      if (url === adaptive.guideUrl) return guide()
      throw new Error('unexpected source URL ' + url)
    }),
  )
}

it('reads the adaptive mode from the OpenRouter guide and mandatory and efforts from the listing', async () => {
  stubFetch(() => new Response(adaptive.guide))
  const listed = await openrouterProvider.listModels({})
  const [opus47, batch, opus45] = listed.models
  const reasoning = {
    mode: 'adaptive',
    mandatory: false,
    efforts: ['max', 'xhigh', 'high', 'medium', 'low'],
  }
  expect(opus47?.reasoning).toEqual(reasoning)
  expect(batch?.reasoning).toEqual(reasoning)
  expect(opus47?.factSources?.reasoning).toMatchObject({
    derivation: 'docs-derived',
    sourceUrl: adaptive.guideUrl,
    sourceHash: await sha256Text(adaptive.guide),
  })
  expect(opus47?.requestMap?.thinking?.on).toEqual({
    reasoning: { effort: 'high' },
  })
  expect(opus45?.reasoning).toEqual({ mode: 'toggle', mandatory: false })
  expect(listed.docsFailures).toBeUndefined()
})

it('keeps the stored reasoning when the guide fails or stops stating adaptive thinking', async () => {
  for (const guide of [
    () => new Response('gone', { status: 500 }),
    () =>
      new Response(
        adaptive.guide.replace(
          'Claude 4.7 Opus supports only adaptive thinking.',
          'Claude 4.7 Opus supports thinking.',
        ),
      ),
  ]) {
    stubFetch(guide)
    const listed = await openrouterProvider.listModels({})
    expect(listed.models[0]?.absent).toEqual({ reasoning: 'unavailable' })
    expect(listed.models[0]?.factSources?.reasoning?.sourceUrl).toBe(
      reasoningDocs.sourceUrl,
    )
    expect(listed.models[2]?.absent).toBeUndefined()
    expect(listed.docsFailures?.failed).toBe(1)
  }
})

it('fetches no guide for a listing with no Claude row the guides name', async () => {
  const fetched: Array<string> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      fetched.push(url)
      if (url === adaptive.sourceUrl)
        return Response.json({ data: [adaptive.listing.data[2]] })
      if (url === reasoningDocs.sourceUrl)
        return new Response(reasoningDocs.markdown)
      throw new Error('unexpected source URL ' + url)
    }),
  )
  const listed = await openrouterProvider.listModels({})
  expect(listed.models[0]?.reasoning?.mode).toBe('toggle')
  expect(fetched).not.toContain(adaptive.guideUrl)
})

it('names each guided id once', () => {
  const ids = OPENROUTER_ADAPTIVE_GUIDES.flatMap((guide) => guide.ids)
  expect(new Set(ids).size).toBe(ids.length)
})
