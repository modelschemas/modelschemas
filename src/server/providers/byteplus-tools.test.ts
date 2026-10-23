import { describe, expect, it } from 'vitest'

import type { ByteplusDoc } from './byteplus-pricing.ts'
import { parseByteplusMcpSupport } from './byteplus-tools.ts'

/** A one-table model-list document, in the page's zone layout. */
function doc(rows: Array<Array<string>>): ByteplusDoc {
  const data: ByteplusDoc['data'] = {
    '0': { ops: [{ insert: '*', attributes: { aceTable: 'rows cols' } }] },
    rows: { ops: rows.map((_, r) => ({ insert: { id: `r${String(r)}` } })) },
    cols: {
      ops: (rows[0] ?? []).map((_, c) => ({ insert: { id: `c${String(c)}` } })),
    },
  }
  rows.forEach((cells, r) => {
    cells.forEach((text, c) => {
      data[`xr${String(r)}xc${String(c)}`] = { ops: [{ insert: `${text}\n` }] }
    })
  })
  return { data }
}

// The model list's Tool use table as served on 2026-10-22, cut down.
const HEADER = [
  'Model ID',
  'Function calling\nResponses API & Chat API',
  'MCP\nResponses API',
]

describe('parseByteplusMcpSupport', () => {
  it('reads each row of the Tool use table', () => {
    const support = parseByteplusMcpSupport(
      doc([
        HEADER,
        ['dola-seed-2-1-turbo-260628', 'Supported', 'Supported'],
        ['seed-2-0-code-preview-260328', 'Supported', 'Not Supported'],
        [
          'seed-1-8-251228 Retiring\n(Recommended replacement: seed-2-0-lite-260428)',
          'Supported',
          'Supported',
        ],
      ]),
    )
    expect([...support]).toEqual([
      ['dola-seed-2-1-turbo-260628', true],
      ['seed-2-0-code-preview-260328', false],
      ['seed-1-8-251228', true],
    ])
  })

  it('reads the Yes / No wording past a Provider column', () => {
    // The Tool use table as served on 2026-10-23, cut down.
    const support = parseByteplusMcpSupport(
      doc([
        ['Provider', 'Model ID', 'Function calling', 'MCP'],
        ['ByteDance', 'dola-seed-2-1-turbo-260628', 'Yes', 'Yes'],
        ['', 'seed-2-0-code-preview-260328', 'Yes', 'No'],
        ['Z.ai', 'glm-5-2-260617', 'Yes', 'Yes'],
      ]),
    )
    expect([...support]).toEqual([
      ['dola-seed-2-1-turbo-260628', true],
      ['seed-2-0-code-preview-260328', false],
      ['glm-5-2-260617', true],
    ])
  })

  it('throws on a missing table or a cell it cannot read', () => {
    expect(() =>
      parseByteplusMcpSupport(doc([['Model ID', 'Capabilities']])),
    ).toThrow('no Tool use table')
    expect(() =>
      parseByteplusMcpSupport(doc([HEADER, ['m-1', 'Supported', 'Beta']])),
    ).toThrow('unread Tool use row')
  })
})
