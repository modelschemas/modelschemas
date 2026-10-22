import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  GROQ_DEPRECATIONS_URL,
  MISTRAL_DEPRECATIONS_URL,
  parseGroqDeprecations,
  parseMistralDeprecations,
} from './deprecations.ts'

// Fetched 2026-10-22: https://console.groq.com/docs/deprecations.md and
// https://docs.mistral.ai/models.md.
const GROQ = readFileSync(
  new URL('./fixtures/groq-deprecations.md.txt', import.meta.url),
  'utf8',
)
const MISTRAL = readFileSync(
  new URL('./fixtures/mistral-models.md.txt', import.meta.url),
  'utf8',
)

const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 1000

describe('groq deprecations page', () => {
  const rows = new Map(parseGroqDeprecations(GROQ).map((r) => [r.rawId, r]))

  it('reads every id issue #410 names, with shutdown date and replacements', () => {
    expect(rows.get('llama-3.3-70b-versatile')).toEqual({
      rawId: 'llama-3.3-70b-versatile',
      deprecatedAt: day('2026-06-17'),
      retiresAt: day('2026-08-16'),
      replacedBy: ['openai/gpt-oss-120b', 'qwen/qwen3.6-27b'],
      sourceUrl: GROQ_DEPRECATIONS_URL,
    })
    expect(rows.get('meta-llama/llama-4-maverick-17b-128e-instruct')).toEqual(
      expect.objectContaining({
        deprecatedAt: day('2026-02-20'),
        retiresAt: day('2026-03-09'),
        replacedBy: ['openai/gpt-oss-120b'],
      }),
    )
    for (const id of [
      'llama-3.1-8b-instant',
      'meta-llama/llama-4-scout-17b-16e-instruct',
      'meta-llama/llama-guard-4-12b',
      'moonshotai/kimi-k2-instruct-0905',
      'qwen/qwen3-32b',
    ]) {
      expect(rows.get(id)?.retiresAt).toBeTypeOf('number')
    }
  })

  it('states no replacement for a dash, and no date where the prose has none', () => {
    expect(rows.get('groq/compound')).toEqual(
      expect.objectContaining({
        deprecatedAt: day('2026-08-24'),
        retiresAt: day('2026-09-21'),
        replacedBy: null,
      }),
    )
    // "we are announcing": no announcement date stated.
    expect(rows.get('mistral-saba-24b')?.deprecatedAt).toBeNull()
    // "In November 2024": a month, not a day.
    expect(rows.get('llama-3.2-90b-text-preview')).toEqual(
      expect.objectContaining({
        deprecatedAt: null,
        replacedBy: ['llama-3.2-90b-vision-preview', 'llama-3.1-70b-versatile'],
      }),
    )
  })

  it('keeps the newest entry for an id listed twice', () => {
    expect(rows.get('deepseek-r1-distill-llama-70b-specdec')?.retiresAt).toBe(
      day('2025-04-14'),
    )
  })

  it('throws on a cell it cannot read', () => {
    expect(() =>
      parseGroqDeprecations(GROQ.replace('| 08/16/26 ', '| soon     ')),
    ).toThrow(/shutdown date/)
    expect(() => parseGroqDeprecations('# nothing')).toThrow()
  })
})

describe('mistral deprecations table', () => {
  const rows = new Map(
    parseMistralDeprecations(MISTRAL).map((r) => [r.rawId, r]),
  )

  it('reads the ids issue #410 names, resolving replacement links to API names', () => {
    expect(rows.get('pixtral-12b-2409')).toEqual({
      rawId: 'pixtral-12b-2409',
      deprecatedAt: day('2025-12-02'),
      retiresAt: day('2025-12-31'),
      replacedBy: ['ministral-14b-2512'],
      sourceUrl: MISTRAL_DEPRECATIONS_URL,
    })
    expect(rows.get('mistral-small-2503')?.replacedBy).toEqual([
      'mistral-small-2603',
    ])
    expect(rows.get('pixtral-large-2411')?.replacedBy).toEqual([
      'mistral-medium-3-5',
    ])
    expect(rows.get('open-mistral-nemo-2407')?.retiresAt).toBe(
      day('2026-07-31'),
    )
    expect(rows.get('mistral-medium-2505')?.deprecatedAt).toBe(
      day('2026-05-22'),
    )
  })

  it('reads prose dates, and leaves empty cells null', () => {
    expect(rows.get('magistral-small-2509')).toEqual(
      expect.objectContaining({
        deprecatedAt: day('2026-04-30'),
        retiresAt: day('2026-07-31'),
      }),
    )
    expect(rows.get('labs-leanstral-1-5')?.replacedBy).toBeNull()
  })

  it('skips rows with no API name', () => {
    expect([...rows.keys()].every((id) => id !== '')).toBe(true)
  })

  it('throws on a reshaped table', () => {
    expect(() =>
      parseMistralDeprecations(MISTRAL.replace('| Retirement |', '| Ends |')),
    ).toThrow(/header/)
    expect(() =>
      parseMistralDeprecations(MISTRAL.replace('| 2026-08-31 |', '| soon |')),
    ).toThrow(/date/)
  })
})
