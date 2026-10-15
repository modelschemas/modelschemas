import { afterEach, expect, it } from 'vitest'
import docs from './fixtures/openai-gpt5-guides.json'
import {
  OPENAI_GPT51_GUIDE_URL,
  OPENAI_GPT52_GUIDE_URL,
  OPENAI_GPT5_GUIDE_URL,
  parseGpt51NoneGuide,
  parseGpt52SamplingGuide,
  parseGpt5FamilyGuide,
} from './openai-gpt5-guides.ts'
import {
  OPENAI_MODELS_INDEX_URL,
  OPENAI_PRICING_URL,
  openaiModelFacts,
} from './openai-model-docs.ts'
import { docsRun } from './model-facts.ts'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

const pricing = `Specialized models

Prices per 1M tokens.

Standard

### Grouped Pricing Table data

| Category | Model | Input | Cached input | Output |
| --- | --- | --- | --- | --- |
| Search | gpt-5-search-api | $1.25 | $0.125 | $10.00 |
`

function serve(guides: Partial<Record<string, string>>) {
  globalThis.fetch = (input) => {
    const url = String(input)
    if (url === OPENAI_MODELS_INDEX_URL)
      return Promise.resolve(
        new Response('[Mini](/api/docs/models/gpt-5-mini.md)'),
      )
    if (url === OPENAI_PRICING_URL)
      return Promise.resolve(new Response(pricing))
    if (url.endsWith('/models/gpt-5-mini.md'))
      return Promise.resolve(new Response(docs['gpt-5-mini-page.md']))
    const guide = guides[url]
    if (guide !== undefined) return Promise.resolve(new Response(guide))
    return Promise.resolve(new Response('outage', { status: 503 }))
  }
}

const allGuides = {
  [OPENAI_GPT5_GUIDE_URL]: docs['gpt-5.md'],
  [OPENAI_GPT51_GUIDE_URL]: docs['gpt-5.1.md'],
  [OPENAI_GPT52_GUIDE_URL]: docs['gpt-5.2.md'],
}

it('reads the family, its efforts, the none statement and the sampling refusal', () => {
  expect(parseGpt5FamilyGuide(docs['gpt-5.md'])).toEqual({
    rawIds: ['gpt-5', 'gpt-5-mini', 'gpt-5-nano'],
    efforts: ['minimal', 'low', 'medium', 'high'],
  })
  expect(parseGpt51NoneGuide(docs['gpt-5.1.md'])).toBe('minimal')
  expect(parseGpt52SamplingGuide(docs['gpt-5.2.md'])).toEqual({
    rawIds: ['gpt-5', 'gpt-5-mini', 'gpt-5-nano'],
    flags: ['temperature', 'top_p'],
  })
})

it('throws when a guide sentence is gone or reworded', () => {
  expect(() =>
    parseGpt5FamilyGuide(
      docs['gpt-5.md'].replace('`high`.', '`high`, and more.'),
    ),
  ).toThrow('family or effort list')
  expect(() =>
    parseGpt5FamilyGuide('```\n' + docs['gpt-5.md'] + '\n```'),
  ).toThrow()
  expect(() =>
    parseGpt51NoneGuide(
      docs['gpt-5.1.md'].replace('never use reasoning', 'use fewer reasoning'),
    ),
  ).toThrow('none statement')
  expect(() =>
    parseGpt52SamplingGuide(
      docs['gpt-5.2.md'].replace('- `temperature`\n', ''),
    ),
  ).toThrow('parameter compatibility')
})

it('fills gpt-5-mini reasoning and sampling noes from the guides, with sources', async () => {
  serve(allGuides)
  const facts = await openaiModelFacts(['gpt-5-mini', 'gpt-5-mini-2025-08-07'])
  for (const id of ['gpt-5-mini', 'gpt-5-mini-2025-08-07']) {
    const row = facts(id)
    expect(row.reasoning).toEqual({
      mode: 'effort',
      mandatory: true,
      efforts: ['minimal', 'low', 'medium', 'high'],
    })
    expect(row.factSources?.reasoning?.sourceUrl).toBe(OPENAI_GPT51_GUIDE_URL)
    expect(row.unsupportedCapabilities).toEqual(['temperature', 'top_p'])
    expect(row.factSources?.capabilities?.temperature?.sourceUrl).toBe(
      OPENAI_GPT52_GUIDE_URL,
    )
    expect(row.absent).toBeUndefined()
  }
})

it('keeps efforts unstated as mandatory null when the none guide fails', async () => {
  serve({
    [OPENAI_GPT5_GUIDE_URL]: docs['gpt-5.md'],
    [OPENAI_GPT52_GUIDE_URL]: docs['gpt-5.2.md'],
  })
  const run = docsRun()
  const row = (await openaiModelFacts(['gpt-5-mini'], undefined, run))(
    'gpt-5-mini',
  )
  expect(row.reasoning?.mandatory).toBeNull()
  expect(row.factSources?.reasoning?.sourceUrl).toBe(OPENAI_GPT5_GUIDE_URL)
  expect(row.absent).toEqual({ reasoning: 'unavailable' })
  expect(run.failed).toBe(1)
})

it('marks GPT-5 rows unavailable when a guide does not parse', async () => {
  serve({
    ...allGuides,
    [OPENAI_GPT52_GUIDE_URL]: '# Using GPT-5.2\n',
  })
  const run = docsRun()
  const row = (await openaiModelFacts(['gpt-5-mini'], undefined, run))(
    'gpt-5-mini',
  )
  expect(row.unsupportedCapabilities).toBeUndefined()
  expect(row.absent).toEqual({ capabilities: 'unavailable' })
  expect(run.first[0]?.source).toBe(OPENAI_GPT52_GUIDE_URL)
})

it('does not fetch the guides when no GPT-5 id is listed', async () => {
  serve({})
  const run = docsRun()
  await openaiModelFacts(['gpt-5.1'], undefined, run)
  expect(run.failed).toBe(0)
})
