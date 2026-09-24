import { describe, expect, it } from 'vitest'

import { byteplusRatesFor, parseByteplusPricing } from './byteplus-pricing.ts'
import type { ByteplusDoc } from './byteplus-pricing.ts'

function cell(id: string, text: string) {
  return {
    ops: [{ insert: '*', attributes: { lmkr: '1' } }, { insert: `${text}\n` }],
    zoneId: id,
    zoneType: 'Z',
  }
}

/**
 * One standard-table row group. `rows` are cell texts in header order:
 * model, tier, input, audio, cache storage, cache hit, audio cache, output.
 */
function doc(rows: Array<Array<string>>): ByteplusDoc {
  const headers = [
    'Model ID',
    'Pricing tiers (K tokens)',
    'Input (non-audio) (USD/M tokens)',
    'Input (audio) (USD/M tokens)',
    'Cache-storage (USD/M tokens/Hour)',
    'Cache-hit input (non-audio) (USD/M tokens)',
    'Cache-hit input (audio) (USD/M tokens)',
    'Output (USD/M tokens)',
  ]
  const body = [headers, ...rows]
  const rowIds = body.map((_, index) => `r${index}`)
  const colIds = headers.map((_, index) => `c${index}`)
  const data: ByteplusDoc['data'] = {
    '0': {
      ops: [
        {
          insert: '*',
          attributes: { aceTable: 'rows cols' },
        },
      ],
    },
    rows: {
      ops: rowIds.map((id) => ({ insert: { id } })),
      zoneType: 'R',
    },
    cols: {
      ops: colIds.map((id) => ({ insert: { id } })),
      zoneType: 'C',
    },
  }
  body.forEach((cells, row) => {
    cells.forEach((text, column) => {
      const id = `xr${row}xc${column}`
      data[id] = cell(id, text)
    })
  })
  return { data }
}

describe('byteplus pricing page', () => {
  it('reads standard token rates, tiers, and a dated catalog suffix', () => {
    const rates = parseByteplusPricing(
      doc([
        [
          'dola-seed-2-1-turbo',
          'Prompt length [0, 256]',
          '0.5',
          '-',
          '0.0083',
          '0.1',
          '-',
          '2.5',
        ],
        [
          'seed-2-0-pro-260328',
          'Prompt length [0, 128]',
          '0.50',
          '-',
          '0.0083',
          '0.10',
          '-',
          '3.00',
        ],
        [
          '',
          'Prompt length (128, 256]',
          '1.00',
          '-',
          '0.0083',
          '0.20',
          '-',
          '6.00',
        ],
        [
          'seed-2-0-lite-260428',
          'Prompt length [0, 128]',
          '0.25',
          '3.75',
          '0.0083',
          '0.05',
          '0.75',
          '2.00',
        ],
        [
          'deepseek-v4-1-flash-260910',
          'Off-peak hours',
          '0.15',
          '-',
          '0.0083',
          '0.003',
          '-',
          '0.60',
        ],
        ['', 'Peak hours', '0.30', '-', '0.0083', '0.006', '-', '1.20'],
        ['glm-5-2-260617', '-', '1.4', '-', '0.0083', '0.26', '-', '4.4'],
      ]),
    )
    expect(rates.get('glm-5-2-260617')).toEqual({
      base: {
        input_tokens: 1.4e-6,
        cache_read_tokens: 0.26e-6,
        output_tokens: 4.4e-6,
      },
      tiers: [],
    })
    expect(rates.get('seed-2-0-lite-260428')?.base.audio_tokens).toBe(3.75e-6)
    expect(rates.get('seed-2-0-pro-260328')?.tiers).toEqual([
      {
        minPromptTokens: 128_000,
        rates: {
          input_tokens: 1 / 1e6,
          cache_read_tokens: 0.2 / 1e6,
          output_tokens: 6 / 1e6,
        },
      },
    ])
    // Cache storage is per hour, so it is not a lever.
    expect(rates.get('glm-5-2-260617')?.base).not.toHaveProperty(
      'cache_storage',
    )
    // Peak and off-peak have no time lever.
    expect(rates.has('deepseek-v4-1-flash-260910')).toBe(false)
    expect(
      byteplusRatesFor('dola-seed-2-1-turbo-260628', rates)?.base.input_tokens,
    ).toBe(0.5e-6)
    expect(byteplusRatesFor('seed-translation-250915', rates)).toBeUndefined()
  })
})
