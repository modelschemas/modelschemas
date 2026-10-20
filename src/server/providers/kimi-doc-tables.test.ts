import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { parseKimiDocTables } from './kimi-doc-tables.ts'

const page = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

// The compiled MDX bodies of both pricing pages (2026-10-20).
const CN = page('platform.kimi.com-pricing-chat.html.txt')
const INTL = page('platform.kimi.ai-pricing-chat.html.txt')

/** platform.kimi.com/docs/pricing/chat.md as served from 2026-10-20. */
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
    expect(tables[0]?.titles).toEqual([
      '模型',
      '计费单位',
      '缓存写入（TTL 5min）',
      '缓存写入（TTL 1h）',
      '输入价格（缓存命中）',
      '输入价格（缓存未命中）',
      '输出价格',
      '上下文窗口',
    ])
    expect(tables[0]?.rows).toEqual([
      [
        'kimi-k3',
        '1M tokens',
        '¥20.00',
        '¥40.00',
        '¥2.00',
        '¥20.00',
        '¥100.00',
        '1,048,576 tokens',
      ],
    ])
    expect(tables[1]?.rows.map((row) => row[0])).toEqual([
      'kimi-k2.7-code',
      'kimi-k2.7-code-highspeed',
      'kimi-k2.6',
    ])
  })

  it('joins a fragment of text into one cell', () => {
    const [k3] = parseKimiDocTables(INTL)
    expect(k3?.section).toBe('Model Pricing')
    expect(k3?.rows[0]).toEqual([
      'kimi-k3',
      '1M tokens',
      '$3.00',
      '$6.00',
      '$0.30',
      '$3.00',
      '$15.00',
      '1,048,576 tokens',
    ])
  })

  it('reads only the first copy of the body', () => {
    const twice = CN.replace('</script>', `${CN}</script>`)
    expect(parseKimiDocTables(twice)).toEqual(parseKimiDocTables(CN))
  })

  it('gives a cell or heading that is not plain text as null', () => {
    const tables = parseKimiDocTables(
      CN.replace('`¥1.10`', '_jsx(_components.del,{children:`¥1.10`})')
        .replace(
          'children:`K2 系列模型`',
          'children:_jsx(_components.code,{children:`K2`})',
        )
        .replace('{title:`输出价格`,width:`14%`}', '{width:`14%`}'),
    )
    expect(tables[1]?.subsection).toBeNull()
    expect(tables[1]?.titles[4]).toBeNull()
    expect(tables[1]?.rows[2]?.[2]).toBeNull()
    expect(tables[1]?.rows[2]?.[3]).toBe('¥6.50')
  })

  it('throws on the empty markdown export and on unknown table props', () => {
    expect(() => parseKimiDocTables(EMPTY_MD_EXPORT)).toThrow(
      'page has no compiled MDX body',
    )
    expect(() =>
      parseKimiDocTables(CN.replaceAll('_jsx(DocTable,', '_jsx(Callout,')),
    ).toThrow('page has no DocTable')
    expect(() =>
      parseKimiDocTables(
        CN.replace('}],rows:[[`kimi-k3`', '}],data:[[`kimi-k3`'),
      ),
    ).toThrow('DocTable props are not columns, rows')
  })
})
