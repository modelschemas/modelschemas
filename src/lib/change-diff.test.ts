import { describe, expect, it } from 'vitest'

import { changeDiffs } from './change-diff.ts'

describe('changeDiffs', () => {
  it('shows each changed path with its before and after value', () => {
    const payload = {
      before: {
        contextWindow: 262144,
        deprecated: true,
        capabilities: { structured_outputs: false },
        pricing: { tables: { rate: { base: { input_tokens: 2.6e-7 } } } },
      },
      after: {
        contextWindow: null,
        deprecated: false,
        capabilities: { structured_outputs: true, response_format: true },
        pricing: { tables: { rate: { base: { input_tokens: 4.7e-7 } } } },
      },
      changed: [
        'capabilities.response_format',
        'contextWindow',
        'deprecated',
        'pricing.tables.rate.base.input_tokens',
      ],
    }
    expect(changeDiffs(payload)).toEqual([
      { path: 'capabilities.response_format', before: '—', after: 'true' },
      { path: 'contextWindow', before: '262144', after: 'null' },
      { path: 'deprecated', before: 'true', after: 'false' },
      {
        path: 'pricing.tables.rate.base.input_tokens',
        before: '$0.26/M',
        after: '$0.47/M',
      },
    ])
  })

  it('names a price that appeared or went away', () => {
    expect(
      changeDiffs({
        before: { pricing: null },
        after: { pricing: { tables: {} } },
        changed: ['pricing'],
      }),
    ).toEqual([{ path: 'pricing', before: 'null', after: 'card' }])
  })

  it('shows nothing for a payload with no changed list', () => {
    expect(changeDiffs({ before: {}, after: {} })).toEqual([])
    expect(changeDiffs(null)).toEqual([])
  })
})
