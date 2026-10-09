import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseGlmCodingModels } from './glm-coding-docs.ts'
import type { CodingDoc, CodingLocale } from './glm-coding-docs.ts'

function docs(locale: CodingLocale) {
  const host = locale === 'en' ? 'docs.z.ai' : 'docs.bigmodel.cn'
  const load = (file: string): CodingDoc => ({
    text: readFileSync(
      new URL(`./fixtures/${host}-${file}.md.txt`, import.meta.url),
      'utf8',
    ),
    url: `https://${host}/${file}.md`,
    hash: 'native-fixture',
  })
  return {
    overview: load('overview'),
    latest: load('latest-model'),
    thinking: load('thinking'),
  }
}
describe('native GLM Coding sources', () => {
  for (const locale of ['en', 'zh'] as const) {
    it(`sources supported ${locale} plan facts without routed legacy ids or borrowed bodies`, () => {
      const rows = parseGlmCodingModels(docs(locale), locale)
      expect(rows.map((row) => row.rawId)).toEqual(['glm-5.3', 'glm-5.3-flash'])
      expect(rows.map((row) => row.contextWindow)).toEqual([1000000, 1000000])
      expect(rows.map((row) => row.modalities)).toEqual([
        { input: ['text'], output: null },
        { input: ['image'], output: null },
      ])
      for (const row of rows) {
        expect(row.pricing).toBeNull()
        expect(row.absent?.pricing).toBe('cleared')
        expect(row.schemaEndpointId).toBeNull()
        expect(row.maxOutput).toBeNull()
        expect(row.reasoning).toEqual({
          mode: 'effort',
          mandatory: true,
          efforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
        })
        expect(row.requestMap?.thinking).toEqual({
          on: { reasoning_effort: 'high' },
          off: null,
          levels: {
            off: null,
            minimal: 'low',
            low: 'low',
            medium: 'high',
            high: 'high',
            xhigh: 'max',
            max: 'max',
          },
        })
        expect(row.requestMap?.maxTokensField).toBeNull()
        expect(row.requestMap?.developerRole).toBeNull()
        expect(row.requestMap?.toolStream).toBeNull()
        expect(row.requestMap?.replayReasoningContent).toBeNull()
      }
    })
  }
  it('fails missing or malformed supported-model and effort scopes', () => {
    const d = docs('en')
    expect(() =>
      parseGlmCodingModels(
        { ...d, overview: { ...d.overview, text: 'No supported model list' } },
        'en',
      ),
    ).toThrow('native overview document heading')
    expect(() =>
      parseGlmCodingModels(
        {
          ...d,
          thinking: {
            ...d.thinking,
            text: d.thinking.text.replace(
              'mapped to `low`',
              'mapped elsewhere',
            ),
          },
        },
        'en',
      ),
    ).toThrow('unreadable Coding effort clause')
  })
  it('leaves absent setting facts null but throws on a recognized unreadable context', () => {
    const d = docs('en')
    const latest = {
      ...d.latest,
      text: d.latest.text
        .split('\n')
        .filter((line) => !/Context Window Size/.test(line))
        .join('\n'),
    }
    expect(
      parseGlmCodingModels({ ...d, latest }, 'en')[0]?.contextWindow,
    ).toBeNull()
    expect(() =>
      parseGlmCodingModels(
        {
          ...d,
          latest: {
            ...d.latest,
            text: d.latest.text.replace('Size to 1000000', 'Size to many'),
          },
        },
        'en',
      ),
    ).toThrow('unreadable plan context')
  })
})

for (const locale of ['en', 'zh'] as const) {
  it(`rejects HTML in every ${locale} native source instead of clearing facts`, () => {
    const d = docs(locale)
    for (const role of ['overview', 'latest', 'thinking'] as const)
      expect(() =>
        parseGlmCodingModels(
          {
            ...d,
            [role]: {
              ...d[role],
              text: '<!DOCTYPE html><html>Not Found</html>',
            },
          },
          locale,
        ),
      ).toThrow('returned HTML')
  })
}
it('rejects fractional or comma-formatted recognized context settings', () => {
  const d = docs('en')
  for (const malformed of ['1000000.5', '1000000,5', '1,000,000'])
    expect(() =>
      parseGlmCodingModels(
        {
          ...d,
          latest: {
            ...d.latest,
            text: d.latest.text.replace(
              'Size to 1000000',
              `Size to ${malformed}`,
            ),
          },
        },
        'en',
      ),
    ).toThrow('unreadable plan context setting')
})
it('does not infer forced thinking merely from a remapped none value or claim a complete capability list', () => {
  const d = docs('en')
  const thinking = {
    ...d.thinking,
    text: d.thinking.text
      .split('\n')
      .filter((line) => !/no longer support disabling thinking/.test(line))
      .join('\n'),
  }
  const rows = parseGlmCodingModels({ ...d, thinking }, 'en')
  expect(rows.every((row) => row.reasoning?.mandatory === null)).toBe(true)
  expect(rows.every((row) => row.exactCapabilities === undefined)).toBe(true)
  expect(rows[0]?.requestMap?.thinking?.levels?.minimal).toBe('low')
  expect(rows[0]?.requestMap?.thinking?.off).toBeNull()
})
