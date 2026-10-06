import { describe, expect, it } from 'vitest'

import { buildReport, failing, parseLedger } from './gap-report.ts'
import type { ModelRow } from './gap-report.ts'

const complete: ModelRow = {
  provider: 'full',
  activity: 'chat',
  contextWindow: 200000,
  maxOutput: 64000,
  modalities: { input: ['text'] },
  pricing: {
    tables: {
      rate: {
        base: {
          input_tokens: 1e-6,
          output_tokens: 2e-6,
          cache_read_tokens: 1e-7,
        },
      },
    },
    source: { url: 'https://docs.example.com/pricing' },
  },
  capabilities: ['reasoning', 'tools'],
  reasoning: { mode: 'effort', efforts: ['low', 'high'] },
  requestMap: { maxTokensField: 'max_tokens' },
  schemaEndpointId: 'full/chat/completions',
}

// Listing-compiled cards carry OpenRouter's key names.
const listingTables = {
  rate: { base: { prompt: 1e-6, completion: 2e-6, input_cache_read: 1e-7 } },
}

const rows: Array<ModelRow> = [
  complete,
  {
    ...complete,
    provider: 'borrowed',
    pricing: {
      tables: listingTables,
      source: { url: 'https://models.dev/api.json' },
    },
  },
  { ...complete, provider: 'quiet', maxOutput: null },
  { provider: 'images', activity: 'image' },
  { provider: 'images', activity: null },
]

const ledger = parseLedger(
  '# Ledger\n\n- quiet: maxOutput — not published (#75)\n',
)
const report = buildReport(rows, ledger, new Date(0))
const provider = (id: string, from = report) => {
  const found = from.providers.find((p) => p.provider === id)
  if (!found) throw new Error(`no provider ${id}`)
  return found
}

describe('gap report scoring', () => {
  it('scores a complete row 1', () => {
    const full = provider('full')
    expect(full.score).toBe(1)
    expect(full.facts.priced).toEqual({ have: 1, need: 1 })
    expect(full.facts.efforts).toEqual({ have: 1, need: 1 })
    expect(report.generatedAt).toBe('1970-01-01T00:00:00.000Z')
  })

  it('does not count a models.dev price as filled', () => {
    const borrowed = provider('borrowed')
    expect(borrowed.fromModelsDev).toBe(1)
    expect(borrowed.facts.priced).toEqual({ have: 0, need: 1 })
    expect(borrowed.facts.cacheRead).toEqual({ have: 0, need: 1 })
    expect(borrowed.score).toBe(0.8)
  })

  it('reads both rate key spellings', () => {
    const own = buildReport([
      { ...complete, pricing: { tables: listingTables } },
    ])
    expect(provider('full', own).score).toBe(1)
  })

  it('counts a card in another currency as priced', () => {
    const yuan = buildReport([
      {
        ...complete,
        pricing: {
          ...complete.pricing,
          price: { currency: ['CNY', 0] },
        } as ModelRow['pricing'],
      },
    ])
    expect(provider('full', yuan).facts.priced).toEqual({ have: 1, need: 1 })
    expect(provider('full', yuan).facts.cacheRead).toEqual({ have: 1, need: 1 })
  })

  it('leaves a ledger fact out of the score', () => {
    const quiet = provider('quiet')
    expect(quiet.silent).toEqual(['maxOutput'])
    expect(quiet.facts.maxOutput).toEqual({ have: 0, need: 1 })
    expect(quiet.score).toBe(1)
  })

  it('scores chat rows 1 when every needed fact is on the ledger', () => {
    const all = parseLedger(
      [
        'contextWindow',
        'maxOutput',
        'modalities',
        'priced',
        'cacheRead',
        'capabilities',
        'requestMap',
        'endpoint',
      ]
        .map((fact) => `- bare: ${fact} — not published`)
        .join('\n'),
    )
    const bare = buildReport(
      [{ provider: 'bare', activity: 'chat' }],
      all,
      new Date(0),
    )
    expect(bare.providers[0]).toMatchObject({ chat: 1, score: 1 })
  })

  it('treats rows with no chat rows as a gap', () => {
    const images = provider('images')
    expect(images).toMatchObject({ rows: 2, chat: 0, noActivity: 1, score: 0 })
    expect(report.providers[0]?.provider).toBe('images')
  })

  it('needs reasoning only where a row claims it', () => {
    const plain = provider(
      'full',
      buildReport([
        { ...complete, capabilities: ['tools'], reasoning: null },
        { ...complete, reasoning: null },
      ]),
    )
    expect(plain.facts.reasoning).toEqual({ have: 0, need: 1 })
    expect(plain.facts.efforts).toEqual({ have: 0, need: 0 })
  })

  it('picks the providers below target', () => {
    expect(failing(report, 1)).toEqual(['borrowed'])
    expect(failing(report, 1, ['full', 'images', 'absent'])).toEqual([
      'images',
      'absent',
    ])
    expect(failing(report, 0.8)).toEqual([])
  })

  it('rejects an unknown ledger fact', () => {
    expect(() => parseLedger('- grok: maxOutputs — typo')).toThrow(
      /unknown fact/,
    )
  })
})
