import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { parseKimiDocTables } from './kimi-doc-tables.ts'

const page = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

// The compiled MDX bodies of both pricing pages (2026-10-23).
const CN = page('platform.kimi.com-pricing-chat.html.txt')
const INTL = page('platform.kimi.ai-pricing-chat.html.txt')

/** platform.kimi.com/docs/pricing/chat.md as served on 2026-10-20. */
const EMPTY_MD_EXPORT = `## 模型定价

### K3 系列模型

<table>
  <thead>
    <tr />
  </thead>

  <tbody />
</table>
`

describe('parseKimiDocTables', () => {
  it('reads each table under its headings', () => {
    const tables = parseKimiDocTables(CN)
    expect(tables.map((table) => [table.section, table.subsection])).toEqual([
      ['模型定价', 'K3 系列模型'],
      ['模型定价', 'K2 系列模型'],
    ])
    // Tooltip titles and linked ids read as their text (issue #484).
    expect(tables[0]?.titles).toEqual([
      '模型',
      '输入',
      '输出',
      '缓存命中',
      '缓存写入（5min）',
      '缓存写入（1h）',
    ])
    expect(tables[0]?.rows.at(-1)).toEqual([
      'kimi-k3',
      '¥20.00 / MTok',
      '¥100.00 / MTok',
      '¥2.00 / MTok',
      '¥20.00 / MTok',
      '¥40.00 / MTok',
    ])
    expect(tables[1]?.rows.map((row) => row[0])).toEqual([
      'kimi-k2.7-code',
      'kimi-k2.7-code-highspeed',
      'kimi-k2.6',
    ])
  })

  it('reads the international page', () => {
    const [k3] = parseKimiDocTables(INTL)
    expect(k3?.section).toBe('Model Pricing')
    expect(k3?.titles).toEqual([
      'Model',
      'Input',
      'Output',
      'Cached Input',
      '5m writes',
      '1h writes',
    ])
    expect(k3?.rows.at(-1)).toEqual([
      'kimi-k3',
      '$3.00 / MTok',
      '$15.00 / MTok',
      '$0.30 / MTok',
      '$3.00 / MTok',
      '$6.00 / MTok',
    ])
  })

  it('joins a fragment of text into one cell', () => {
    const tables = parseKimiDocTables(
      CN.replace(
        '`¥1.10 / MTok`',
        '_jsxs(_Fragment,{children:[`¥`,`1.10 / MTok`]})',
      ),
    )
    expect(tables[1]?.rows[2]?.[3]).toBe('¥1.10 / MTok')
  })

  it('reads only the first copy of the body', () => {
    const twice = CN.replace('</script>', `${CN}</script>`)
    expect(parseKimiDocTables(twice)).toEqual(parseKimiDocTables(CN))
  })

  it('gives a cell or heading that is not plain text as null', () => {
    const tables = parseKimiDocTables(
      CN.replace(
        '`¥1.10 / MTok`',
        '_jsx(_components.del,{children:`¥1.10 / MTok`})',
      )
        .replace(
          'children:`K2 系列模型`',
          'children:_jsx(_components.code,{children:`K2`})',
        )
        .replace('{title:`输出`,width:`22%`}', '{width:`22%`}')
        .replace(
          'children:`kimi-k2.6`',
          'children:_jsx(_components.code,{children:`kimi-k2.6`})',
        ),
    )
    expect(tables[1]?.subsection).toBeNull()
    expect(tables[1]?.titles[2]).toBeNull()
    expect(tables[1]?.rows[2]?.[0]).toBeNull()
    expect(tables[1]?.rows[2]?.[3]).toBeNull()
    expect(tables[1]?.rows[2]?.[1]).toBe('¥6.50 / MTok')
  })

  it('reads a single-child fragment and heading props in any order', () => {
    const tables = parseKimiDocTables(
      CN.replace(
        '`¥1.10 / MTok`',
        '_jsx(_Fragment,{children:`¥1.10 / MTok`})',
      ).replace(
        '_jsx(Heading,{level:`3`,id:`k2-系列模型`,children:`K2 系列模型`})',
        '_jsx(Heading,{id:`k2-系列模型`,children:`K2 系列模型`,level:`3`})',
      ),
    )
    expect(tables[1]?.subsection).toBe('K2 系列模型')
    expect(tables[1]?.rows[2]?.[3]).toBe('¥1.10 / MTok')
  })

  it('reads a markdown heading the page compiles to _components.h2', () => {
    const tables = parseKimiDocTables(
      CN.replace(
        '_jsx(Heading,{level:`2`,id:`模型定价`,children:`模型定价`})',
        '_jsx(_components.h2,{id:`模型定价`,children:`模型定价`})',
      ),
    )
    expect(tables[0]?.section).toBe('模型定价')
  })

  it('throws on the empty markdown export and on unknown table props', () => {
    expect(() => parseKimiDocTables(EMPTY_MD_EXPORT)).toThrow(
      'page has no compiled MDX body',
    )
    expect(() =>
      parseKimiDocTables(CN.replaceAll('_jsx(DocTable,', '_jsx(Callout,')),
    ).toThrow('page has no DocTable')
    expect(() =>
      parseKimiDocTables(CN.replace('}],rows:[[', '}],data:[[')),
    ).toThrow('DocTable props are not columns, rows')
    expect(() =>
      parseKimiDocTables(
        CN.replace(
          '_jsx(DocTable,{className:',
          '_jsx(DocTable,{caption:`x`,className:',
        ),
      ),
    ).toThrow('DocTable props are not columns, rows')
    expect(() =>
      parseKimiDocTables(CN.replace('rows:[[', 'rows:[...more,[')),
    ).toThrow('DocTable row is not an array')
    expect(() =>
      parseKimiDocTables(
        CN.replace('_jsx(Heading,{level:`3`,', '_jsx(Heading,{level:three,'),
      ),
    ).toThrow('heading level is unreadable')
  })
})
