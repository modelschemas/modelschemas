import { afterEach, expect, it, vi } from 'vitest'
import { openrouterProvider } from './openrouter.ts'
import {
  OPENROUTER_ADAPTIVE_GUIDES,
  statesAdaptive,
} from './openrouter-reasoning.ts'
import { sha256Text } from './types.ts'
import adaptive from './fixtures/openrouter-claude-adaptive.json'
import reasoningDocs from './fixtures/openrouter-native-toggle.json'

afterEach(() => {
  vi.unstubAllGlobals()
})

const [OPUS_47, , OPUS_45] = adaptive.listing.data
const GUIDE_46 = OPENROUTER_ADAPTIVE_GUIDES[0]?.url

function stubFetch(
  guide: () => Response,
  data: Array<unknown> = adaptive.listing.data,
  guide46?: () => Response,
) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url === adaptive.sourceUrl) return Response.json({ data })
      if (url === reasoningDocs.sourceUrl)
        return new Response(reasoningDocs.markdown)
      if (url === adaptive.guideUrl) return guide()
      if (url === GUIDE_46 && guide46) return guide46()
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
  expect(listed.docsFailures).toEqual({ failed: 0, skipped: 0, first: [] })
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

it('keeps the stored reasoning of a guided row whose listing no longer reads as efforts', async () => {
  stubFetch(
    () => new Response(adaptive.guide),
    [{ ...OPUS_47, reasoning: OPUS_45?.reasoning }],
  )
  const listed = await openrouterProvider.listModels({})
  expect(listed.models[0]?.reasoning?.mode).toBe('toggle')
  expect(listed.models[0]?.absent).toEqual({ reasoning: 'unavailable' })
})

it('marks only the failing guide rows unavailable', async () => {
  stubFetch(
    () => new Response(adaptive.guide),
    [OPUS_47, { ...OPUS_47, id: 'anthropic/claude-opus-4.6' }],
    () => new Response('gone', { status: 500 }),
  )
  const listed = await openrouterProvider.listModels({})
  expect(listed.models[0]?.reasoning?.mode).toBe('adaptive')
  expect(listed.models[0]?.absent).toBeUndefined()
  expect(listed.models[1]?.absent).toEqual({ reasoning: 'unavailable' })
  expect(listed.docsFailures?.failed).toBe(1)
})

it('leaves a Claude id no guide names at its listed mode', async () => {
  stubFetch(
    () => new Response(adaptive.guide),
    [{ ...OPUS_47, id: 'anthropic/claude-opus-6' }],
  )
  const listed = await openrouterProvider.listModels({})
  expect(listed.models[0]?.reasoning?.mode).toBe('effort')
  expect(listed.models[0]?.absent).toBeUndefined()
})

it('matches each guide sentence against its published prose', () => {
  const excerpts: Record<string, string> = {
    ...adaptive.guideExcerpts,
    [adaptive.guideUrl]: adaptive.guide,
  }
  for (const guide of OPENROUTER_ADAPTIVE_GUIDES) {
    const prose = excerpts[guide.url]
    expect(prose, guide.url).toBeDefined()
    expect(statesAdaptive(prose ?? '', guide), guide.url).toBe(true)
  }
})

it('names each guided id once', () => {
  const ids = OPENROUTER_ADAPTIVE_GUIDES.flatMap((guide) => guide.ids)
  expect(new Set(ids).size).toBe(ids.length)
})
