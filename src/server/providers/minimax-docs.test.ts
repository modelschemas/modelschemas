import { afterEach, describe, expect, it } from 'vitest'

import {
  MINIMAX_CN_MAX_COMPLETION_TOKENS,
  MINIMAX_CN_PRICING_PAGE,
  MINIMAX_CN_SDK_PAGE,
  MINIMAX_MAX_COMPLETION_TOKENS,
  MINIMAX_PRICING_PAGE,
  MINIMAX_SDK_PAGE,
} from './fixtures/minimax-docs.ts'
import {
  fetchMinimaxPage,
  MINIMAX,
  MINIMAX_CN,
  minimaxModelFacts,
  parseMinimaxContextWindows,
  parseMinimaxInputModalities,
  parseMinimaxMaxOutput,
  parseMinimaxPricing,
  parseMinimaxReasoning,
} from './minimax-docs.ts'

const IDS = [
  'MiniMax-M3.1-Flash-Preview',
  'MiniMax-M3',
  'MiniMax-M2.7',
  'MiniMax-M2.7-highspeed',
  'MiniMax-M2.5',
  'MiniMax-M2.5-highspeed',
  'MiniMax-M2.1',
  'MiniMax-M2.1-highspeed',
  'MiniMax-M2',
]

describe('minimax docs', () => {
  it('reads every context window from the Supported Models table', () => {
    const windows = parseMinimaxContextWindows(MINIMAX_SDK_PAGE)
    expect([...windows.keys()]).toEqual(IDS)
    expect(windows.get('MiniMax-M3.1-Flash-Preview')).toBe(1_000_000)
    expect(windows.get('MiniMax-M2')).toBe(204_800)
  })

  it('gives image and video input only to the models the table names', () => {
    const inputs = parseMinimaxInputModalities(MINIMAX_SDK_PAGE, IDS)
    expect(inputs.get('MiniMax-M3.1-Flash-Preview')).toEqual([
      'text',
      'image',
      'video',
    ])
    expect(inputs.get('MiniMax-M3')).toEqual(['text', 'image', 'video'])
    expect(inputs.get('MiniMax-M2.7-highspeed')).toEqual(['text'])
    expect(inputs.size).toBe(IDS.length)
  })

  it('reads thinking from the control table and efforts for M3.1 only', () => {
    const reasoning = parseMinimaxReasoning(MINIMAX_SDK_PAGE, IDS)
    expect(reasoning.get('MiniMax-M3.1-Flash-Preview')).toEqual({
      mode: 'adaptive',
      mandatory: true,
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    })
    expect(reasoning.get('MiniMax-M3')).toEqual({
      mode: 'adaptive',
      mandatory: false,
    })
    for (const id of IDS.slice(2)) {
      expect(reasoning.get(id)).toEqual({ mode: 'adaptive', mandatory: true })
    }
  })

  it('reads the output cap for the named models and for the rest', () => {
    const caps = parseMinimaxMaxOutput(MINIMAX_MAX_COMPLETION_TOKENS, IDS)
    expect(caps.get('MiniMax-M3.1-Flash-Preview')).toBe(524_288)
    expect(caps.get('MiniMax-M3')).toBe(524_288)
    expect(caps.get('MiniMax-M2.7')).toBe(204_800)
    expect(caps.size).toBe(IDS.length)
  })

  it('leaves the output cap empty when the sentence changes shape', () => {
    expect(
      parseMinimaxMaxOutput('Upper limit for generated tokens.', IDS).size,
    ).toBe(0)
  })

  it('stores no output cap when the clause naming a model is reworded', () => {
    // Only the M3 clause changes; `other models` still parses and must not
    // be handed to the models the sentence names.
    const reworded = MINIMAX_MAX_COMPLETION_TOKENS.replace(
      'the maximum is 524288',
      'the upper bound is 524288',
    )
    expect(reworded).not.toBe(MINIMAX_MAX_COMPLETION_TOKENS)
    expect(parseMinimaxMaxOutput(reworded, IDS).size).toBe(0)
  })

  it('never gives a named model the other-models cap, whatever the clause order', () => {
    const swapped =
      'For other models the recommended value is 65536 (64K) and the maximum is 204800 (200K); for MiniMax-M3.1-Flash-Preview and MiniMax-M3 the recommended value is 131072 (128K) and the maximum is 524288 (512K).'
    const caps = parseMinimaxMaxOutput(swapped, IDS)
    expect(caps.get('MiniMax-M3')).toBe(524_288)
    expect(caps.get('MiniMax-M3.1-Flash-Preview')).toBe(524_288)
    expect(caps.get('MiniMax-M2')).toBe(204_800)

    const othersOnly =
      'For other models the maximum is 204800 (200K); MiniMax-M3 has a higher limit.'
    expect(parseMinimaxMaxOutput(othersOnly, IDS).size).toBe(0)
    expect(
      parseMinimaxMaxOutput('For other models the maximum is 204800.', IDS)
        .size,
    ).toBe(0)
  })

  it('refuses a struck price whose badge is not permanent', () => {
    const promo = MINIMAX_PRICING_PAGE.replaceAll(
      'Permanent 50% off',
      '50% off until Dec 31',
    )
    expect(promo).not.toBe(MINIMAX_PRICING_PAGE)
    const prices = parseMinimaxPricing(promo)
    expect(prices.has('MiniMax-M3')).toBe(false)
    expect(prices.size).toBe(7)

    // One row losing its badge refuses the whole model, not just that tier.
    const half = MINIMAX_PRICING_PAGE.replace(
      'Permanent 50% off',
      'Limited offer',
    )
    expect(parseMinimaxPricing(half).has('MiniMax-M3')).toBe(false)
  })

  it('prices the standard tier at the billed amount, with the long-context tier', () => {
    const prices = parseMinimaxPricing(MINIMAX_PRICING_PAGE)
    // The Priority tab ($0.45) and the struck list price ($0.60) are not used.
    expect(prices.get('MiniMax-M3')).toEqual({
      base: {
        input_tokens: 0.3 / 1e6,
        output_tokens: 1.2 / 1e6,
        cache_read_tokens: 0.06 / 1e6,
      },
      tiers: [
        {
          minPromptTokens: 512_000,
          rates: {
            input_tokens: 0.6 / 1e6,
            output_tokens: 2.4 / 1e6,
            cache_read_tokens: 0.12 / 1e6,
          },
        },
      ],
    })
    expect(prices.get('MiniMax-M2.7-highspeed')).toEqual({
      base: {
        input_tokens: 0.6 / 1e6,
        output_tokens: 2.4 / 1e6,
        cache_read_tokens: 0.06 / 1e6,
        cache_write_tokens: 0.375 / 1e6,
      },
      tiers: [],
    })
    expect(prices.get('MiniMax-M2')?.base.cache_read_tokens).toBe(0.03 / 1e6)
    // No pay-as-you-go price is published for the M Plan preview model.
    expect(prices.has('MiniMax-M3.1-Flash-Preview')).toBe(false)
    expect(prices.size).toBe(8)
  })
})

describe('minimax-cn pricing', () => {
  const cn = (page: string) => parseMinimaxPricing(page, MINIMAX_CN)

  it('prices the 标准 tier in yuan at the billed amount, with the long-context tier', () => {
    const prices = cn(MINIMAX_CN_PRICING_PAGE)
    // The 优先 tab (3.15) and the struck list price (4.20) are not used.
    expect(prices.get('MiniMax-M3')).toEqual({
      base: {
        input_tokens: 2.1 / 1e6,
        output_tokens: 8.4 / 1e6,
        cache_read_tokens: 0.42 / 1e6,
      },
      tiers: [
        {
          minPromptTokens: 512_000,
          rates: {
            input_tokens: 4.2 / 1e6,
            output_tokens: 16.8 / 1e6,
            cache_read_tokens: 0.84 / 1e6,
          },
        },
      ],
    })
    expect(prices.get('MiniMax-M2.7-highspeed')).toEqual({
      base: {
        input_tokens: 4.2 / 1e6,
        output_tokens: 16.8 / 1e6,
        cache_read_tokens: 0.42 / 1e6,
        cache_write_tokens: 2.625 / 1e6,
      },
      tiers: [],
    })
    expect(prices.get('MiniMax-M2')?.base.cache_read_tokens).toBe(0.21 / 1e6)
    // No pay-as-you-go price is published for the M Plan preview model.
    expect(prices.has('MiniMax-M3.1-Flash-Preview')).toBe(false)
    expect(prices.size).toBe(8)
  })

  it('reads nothing across platforms', () => {
    expect(parseMinimaxPricing(MINIMAX_CN_PRICING_PAGE).size).toBe(0)
    expect(cn(MINIMAX_PRICING_PAGE).size).toBe(0)
  })

  it('refuses a struck price whose badge is not permanent', () => {
    const promo = MINIMAX_CN_PRICING_PAGE.replaceAll('永久五折', '限时五折')
    expect(promo).not.toBe(MINIMAX_CN_PRICING_PAGE)
    expect(cn(promo).has('MiniMax-M3')).toBe(false)
    expect(cn(promo).size).toBe(7)
    // One row losing its badge refuses the whole model, not just that tier.
    const half = MINIMAX_CN_PRICING_PAGE.replace('永久五折', '限时五折')
    expect(cn(half).has('MiniMax-M3')).toBe(false)
  })

  it.each([
    [
      'a unit in the cell',
      '| 2.1 | 8.4 | 0.42 | 2.625 |',
      '| 2.1 元 | 8.4 | 0.42 | 2.625 |',
    ],
    [
      'a 万 suffix',
      '| 2.1 | 8.4 | 0.42 | 2.625 |',
      '| 2.1万 | 8.4 | 0.42 | 2.625 |',
    ],
    [
      'a range',
      '| 2.1 | 8.4 | 0.42 | 2.625 |',
      '| 2.1 | 8.4-16.8 | 0.42 | 2.625 |',
    ],
    ['a reworded unit', '元/百万 tokens', '元/千 tokens'],
    ['a renamed section', '## 语言模型', '## 文本模型'],
  ])('stores no price for %s', (_name, from, to) => {
    const page = MINIMAX_CN_PRICING_PAGE.replaceAll(from, to)
    expect(page).not.toBe(MINIMAX_CN_PRICING_PAGE)
    expect(cn(page).has('MiniMax-M2.7')).toBe(false)
  })
})

/**
 * Page shapes that once stored a wrong number with no throw. Each must
 * leave the model unpriced (or the page empty) on both platforms.
 */
describe.each([
  {
    name: 'minimax',
    platform: MINIMAX,
    page: MINIMAX_PRICING_PAGE,
    tier: '> 512k input tokens',
    tierRewordings: [
      'over 512k input tokens',
      '512k+ input tokens',
      '＞ 512k input tokens',
      '> 51.2万 input tokens',
    ],
    priority: '<Tab title="Priority*">',
    row: '| **MiniMax-M2.7** | \\$0.3 / M tokens | \\$1.2 / M tokens | \\$0.06 / M tokens | \\$0.375 / M tokens |',
    batchRow:
      '| **MiniMax-M2.7** | \\$0.15 / M tokens | \\$0.6 / M tokens | \\$0.03 / M tokens | \\$0.1875 / M tokens |',
    header:
      '| Model | Input | Output | Prompt caching Read | Prompt caching Write |',
    cacheHeader: 'Prompt caching Read',
    cacheCell: ['\\$0.06 / M tokens | \\$0.375', 'free | \\$0.375'],
    base: { input_tokens: 0.3 / 1e6, output_tokens: 1.2 / 1e6 },
  },
  {
    name: 'minimax-cn',
    platform: MINIMAX_CN,
    page: MINIMAX_CN_PRICING_PAGE,
    tier: '> 512k 输入 tokens',
    tierRewordings: [
      '超过 512k 输入 tokens',
      '512k 以上',
      '＞ 512k 输入 tokens',
      '> 51.2万 输入 tokens',
    ],
    priority: '<Tab title="优先*">',
    row: '| **MiniMax-M2.7** | 2.1 | 8.4 | 0.42 | 2.625 |',
    batchRow: '| **MiniMax-M2.7** | 1.05 | 4.2 | 0.21 | 1.3125 |',
    header:
      '| **模型** | **输入价格**<br /> 元/百万 tokens | **输出价格**<br /> 元/百万 tokens | **缓存读取**<br /> 元/百万 tokens | **缓存写入**<br /> 元/百万 tokens |',
    cacheHeader: '**缓存读取**<br /> 元/百万 tokens',
    cacheCell: ['| 2.1 | 8.4 | 0.42 |', '| 2.1 | 8.4 | 免费 |'],
    base: { input_tokens: 2.1 / 1e6, output_tokens: 8.4 / 1e6 },
  },
])('$name pricing refuses what it cannot attribute', (c) => {
  const parse = (page: string) => parseMinimaxPricing(page, c.platform)
  const edit = (from: string, to: string, all = true) => {
    const page = all ? c.page.replaceAll(from, to) : c.page.replace(from, to)
    expect(page).not.toBe(c.page)
    return parse(page)
  }

  it('reads the page as published', () => {
    const prices = parse(c.page)
    expect(prices.size).toBe(8)
    expect(prices.get('MiniMax-M3')?.tiers).toHaveLength(1)
    expect(prices.get('MiniMax-M2.7')?.base).toMatchObject(c.base)
  })

  it.each(c.tierRewordings)(
    'a tier bound reworded to %j is never the base price',
    (reworded) => {
      const prices = edit(c.tier, reworded)
      expect(prices.has('MiniMax-M3')).toBe(false)
      expect(prices.size).toBe(7)
    },
  )

  it.each([
    ['an extra attribute', (tag: string) => tag.replace('>', ' icon="bolt">')],
    ['single quotes', (tag: string) => tag.replaceAll('"', "'")],
  ])('prices nothing when the priority tab tag has %s', (_name, mutate) => {
    expect(edit(c.priority, mutate(c.priority)).size).toBe(0)
  })

  it('refuses the model when tabs become headings and both tiers show', () => {
    const page = c.page
      .replace(/<Tab title="[^"]*">/g, '**tier**')
      .replaceAll('</Tab>', '')
    expect(page).not.toBe(c.page)
    const prices = parse(page)
    expect(prices.has('MiniMax-M3')).toBe(false)
    expect(prices.size).toBe(7)
  })

  it('prices nothing under a sub-heading it cannot attribute', () => {
    expect(edit(c.header, `### Batch\n\n${c.header}`, false).size).toBe(0)
  })

  it('refuses a model a second table prices again', () => {
    const batch = [c.header, '| :- | :- | :- | :- | :- |', c.batchRow].join(
      '\n',
    )
    const prices = edit(c.row, `${c.row}\n\n**Batch**\n\n${batch}`, false)
    expect(prices.has('MiniMax-M2.7')).toBe(false)
    expect(prices.size).toBe(7)
  })

  it('refuses a model whose tier threshold repeats', () => {
    const tierRow = c.page.split('\n').find((line) => line.includes(c.tier))
    if (!tierRow) throw new Error('no tier row')
    const prices = edit(tierRow, `${tierRow}\n${tierRow}`, false)
    expect(prices.has('MiniMax-M3')).toBe(false)
  })

  it('refuses a row with a qualifier beside the id', () => {
    const prices = edit(
      '**MiniMax-M2.7** |',
      '**MiniMax-M2.7** (batch) |',
      false,
    )
    expect(prices.has('MiniMax-M2.7')).toBe(false)
  })

  it('refuses a row whose cache cell does not read, rather than drop the lever', () => {
    const prices = edit(c.cacheCell[0] ?? '', c.cacheCell[1] ?? '', false)
    expect(prices.has('MiniMax-M2.7')).toBe(false)
    expect(prices.size).toBe(7)
  })

  describe('accordions', () => {
    const legacy = `<Accordion title="${c.platform.legacyAccordion}">`
    const published = JSON.stringify([...parse(c.page)])
    const same = (page: string) => {
      expect(page).not.toBe(c.page)
      expect(JSON.stringify([...parse(page)])).toBe(published)
    }

    it('ignores a text-only accordion, whatever its title or attributes', () => {
      const faq =
        '<Accordion title="FAQ" icon="circle-question">\n  Prices exclude tax.\n\n  | Tier | Note |\n  | :- | :- |\n  | Standard | default |\n</Accordion>\n\n'
      same(c.page.replace(legacy, faq + legacy))
      same(c.page.replace('<Tabs>', `${faq}<Tabs>`))
    })

    it('still reads the legacy accordion when it gains an attribute', () => {
      same(c.page.replace(legacy, legacy.replace('>', ' defaultOpen>')))
      same(
        c.page.replace(
          legacy,
          legacy.replace('<Accordion ', '<Accordion icon="clock" '),
        ),
      )
    })

    it('prices nothing when the legacy accordion is retitled', () => {
      expect(edit(legacy, '<Accordion title="Batch">').size).toBe(0)
    })

    it('prices nothing when an unknown accordion holds a price table', () => {
      const batch = [
        '<Accordion title="Batch">',
        c.header,
        '| :- | :- | :- | :- | :- |',
        c.batchRow.replace('MiniMax-M2.7', 'MiniMax-B1'),
        '</Accordion>',
        '',
        legacy,
      ].join('\n')
      expect(edit(legacy, batch).size).toBe(0)
    })
  })

  it('refuses a base bound that does not meet the tier', () => {
    const prices = edit('≤ 512k', '≤ 256k')
    expect(prices.has('MiniMax-M3')).toBe(false)
    expect(prices.size).toBe(7)
    // A bounded base with no tier above it, and a tier over an open base.
    const tierRow = c.page.split('\n').find((line) => line.includes(c.tier))
    if (!tierRow) throw new Error('no tier row')
    expect(edit(`${tierRow}\n`, '', false).has('MiniMax-M3')).toBe(false)
    expect(edit(c.tier.replace('>', '≤'), '').has('MiniMax-M3')).toBe(false)
  })

  it('prices nothing under a header it does not know', () => {
    expect(edit(c.cacheHeader, `${c.cacheHeader} (peak)`).size).toBe(0)
  })
})

describe('minimax-cn docs', () => {
  it('reads every context window from the 支持的模型 table', () => {
    const windows = parseMinimaxContextWindows(MINIMAX_CN_SDK_PAGE, MINIMAX_CN)
    expect([...windows.keys()]).toEqual(IDS)
    expect(windows.get('MiniMax-M3.1-Flash-Preview')).toBe(1_000_000)
    expect(windows.get('MiniMax-M2')).toBe(204_800)
    // The English wording reads nothing off the Chinese page, and back.
    expect(parseMinimaxContextWindows(MINIMAX_CN_SDK_PAGE).size).toBe(0)
    expect(parseMinimaxContextWindows(MINIMAX_SDK_PAGE, MINIMAX_CN).size).toBe(
      0,
    )
  })

  it('gives image and video input only to the models the table names', () => {
    const inputs = parseMinimaxInputModalities(
      MINIMAX_CN_SDK_PAGE,
      IDS,
      MINIMAX_CN,
    )
    expect(inputs.get('MiniMax-M3.1-Flash-Preview')).toEqual([
      'text',
      'image',
      'video',
    ])
    expect(inputs.get('MiniMax-M3')).toEqual(['text', 'image', 'video'])
    for (const id of IDS.slice(2)) expect(inputs.get(id)).toEqual(['text'])
  })

  it('stores no modalities when a support status is reworded', () => {
    // `M3 不支持` names M3 as the one model without video: it must not
    // read as the one model with it, nor leave every model text-only.
    for (const status of ['M3 不支持', '部分支持', 'M3.1-Flash-Preview / M3']) {
      const reworded = MINIMAX_CN_SDK_PAGE.replace(
        '| `type="video"` | 仅 M3.1-Flash-Preview / M3 |',
        `| \`type="video"\` | ${status} |`,
      )
      expect(reworded).not.toBe(MINIMAX_CN_SDK_PAGE)
      expect(parseMinimaxInputModalities(reworded, IDS, MINIMAX_CN).size).toBe(
        0,
      )
    }
  })

  it('reads thinking from the control table and efforts for M3.1 only', () => {
    const reasoning = parseMinimaxReasoning(
      MINIMAX_CN_SDK_PAGE,
      IDS,
      MINIMAX_CN,
    )
    expect(reasoning.get('MiniMax-M3.1-Flash-Preview')).toEqual({
      mode: 'adaptive',
      mandatory: true,
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    })
    expect(reasoning.get('MiniMax-M3')).toEqual({
      mode: 'adaptive',
      mandatory: false,
    })
    for (const id of IDS.slice(2)) {
      expect(reasoning.get(id)).toEqual({ mode: 'adaptive', mandatory: true })
    }
  })

  it('stores no reasoning for a row whose disabled cell is reworded', () => {
    const reworded = MINIMAX_CN_SDK_PAGE.replace(
      '保持 thinking 关闭',
      '可能保持 thinking 关闭',
    ).replace('thinking 仍保持开启', 'thinking 行为不变')
    const reasoning = parseMinimaxReasoning(reworded, IDS, MINIMAX_CN)
    expect([...reasoning.keys()]).toEqual(['MiniMax-M3.1-Flash-Preview'])
  })

  it('reads the output cap for the named models and for the rest', () => {
    const caps = parseMinimaxMaxOutput(
      MINIMAX_CN_MAX_COMPLETION_TOKENS,
      IDS,
      MINIMAX_CN,
    )
    // 131072 and 65536 are the recommended values, not the caps.
    expect(caps.get('MiniMax-M3.1-Flash-Preview')).toBe(524_288)
    expect(caps.get('MiniMax-M3')).toBe(524_288)
    for (const id of IDS.slice(2)) expect(caps.get(id)).toBe(204_800)
  })

  it('stores no output cap when the clause naming a model is reworded', () => {
    const reworded = MINIMAX_CN_MAX_COMPLETION_TOKENS.replace(
      '上限为 524288',
      '最多 524288',
    )
    expect(reworded).not.toBe(MINIMAX_CN_MAX_COMPLETION_TOKENS)
    expect(parseMinimaxMaxOutput(reworded, IDS, MINIMAX_CN).size).toBe(0)
    expect(
      parseMinimaxMaxOutput('其他模型上限为 204800。', IDS, MINIMAX_CN).size,
    ).toBe(0)
  })
})

// Each rewording below once stored a wrong value. All must store nothing.
describe('minimax docs rewordings that must not store a value', () => {
  const EN_M3 =
    'for MiniMax-M3.1-Flash-Preview and MiniMax-M3 the recommended value is 131072 (128K) and the maximum is 524288 (512K)'
  const EN_REST =
    'for other models the recommended value is 65536 (64K) and the maximum is 204800 (200K)'
  const CN_M3 =
    'MiniMax-M3.1-Flash-Preview 和 MiniMax-M3 推荐值为 131072（128K），上限为 524288（512K）'
  const CN_REST = '其他模型推荐值为 65536（64K），上限为 204800（200K）'

  it('keeps the fixtures in step with the clauses these tests rebuild', () => {
    expect(MINIMAX_MAX_COMPLETION_TOKENS.toLowerCase()).toContain(
      `${EN_M3}; ${EN_REST}.`.toLowerCase(),
    )
    expect(MINIMAX_CN_MAX_COMPLETION_TOKENS).toContain(`${CN_M3}；${CN_REST}。`)
  })

  it('refuses a catch-all clause run together with the clause naming ids', () => {
    for (const text of [
      `${EN_REST}, ${EN_M3}.`,
      `${EN_REST} and ${EN_M3}.`,
      `${EN_M3}, ${EN_REST}.`,
    ]) {
      expect(parseMinimaxMaxOutput(text, IDS).size).toBe(0)
    }
    for (const text of [
      `${CN_REST}，${CN_M3}。`,
      `${CN_REST};${CN_M3}。`,
      `${CN_M3}，${CN_REST}。`,
    ]) {
      expect(parseMinimaxMaxOutput(text, IDS, MINIMAX_CN).size).toBe(0)
    }
    // Reordered with the separator kept, both still parse.
    expect(
      parseMinimaxMaxOutput(`${EN_REST}; ${EN_M3}.`, IDS).get('MiniMax-M3'),
    ).toBe(524_288)
    expect(
      parseMinimaxMaxOutput(`${CN_REST}；${CN_M3}。`, IDS, MINIMAX_CN).get(
        'MiniMax-M3',
      ),
    ).toBe(524_288)
  })

  it('refuses a clause with two maximums', () => {
    expect(
      parseMinimaxMaxOutput(
        'For MiniMax-M3 the maximum is 524288 and for MiniMax-M3.1-Flash-Preview the maximum is 262144; for other models the maximum is 204800.',
        IDS,
      ).size,
    ).toBe(0)
    expect(
      parseMinimaxMaxOutput(
        'MiniMax-M3 上限为 524288，MiniMax-M3.1-Flash-Preview 上限为 262144；其他模型上限为 204800。',
        IDS,
        MINIMAX_CN,
      ).size,
    ).toBe(0)
  })

  it('refuses a maximum written with a unit or a decimal', () => {
    for (const [m3, rest] of [
      ['512K', '200K'],
      ['512k', '200k'],
      ['512 K', '200 K'],
      ['0.5M', '0.2M'],
      ['1M', '200K'],
    ]) {
      expect(
        parseMinimaxMaxOutput(
          `For MiniMax-M3.1-Flash-Preview and MiniMax-M3 the maximum is ${m3}; for other models the maximum is ${rest}.`,
          IDS,
        ).size,
      ).toBe(0)
      expect(
        parseMinimaxMaxOutput(
          `MiniMax-M3.1-Flash-Preview 和 MiniMax-M3 推荐值为 128K，上限为 ${m3}；其他模型推荐值为 64K，上限为 ${rest}。`,
          IDS,
          MINIMAX_CN,
        ).size,
      ).toBe(0)
    }
    expect(
      parseMinimaxMaxOutput(
        'MiniMax-M3.1-Flash-Preview 和 MiniMax-M3 上限为 52 万；其他模型上限为 20 万。',
        IDS,
        MINIMAX_CN,
      ).size,
    ).toBe(0)
    // One clause with a unit refuses the rest too.
    expect(
      parseMinimaxMaxOutput(`${CN_M3}；其他模型上限为 200K。`, IDS, MINIMAX_CN)
        .size,
    ).toBe(0)
  })

  it('does not read a cap on the recommended value as the output cap', () => {
    expect(
      parseMinimaxMaxOutput(
        'MiniMax-M3.1-Flash-Preview 和 MiniMax-M3 推荐值上限为 131072，最高 524288；其他模型推荐值上限为 65536，最高 204800。',
        IDS,
        MINIMAX_CN,
      ).size,
    ).toBe(0)
  })

  it('refuses an input status that names models but is not an only-list', () => {
    const en = (status: string) => {
      const page = MINIMAX_SDK_PAGE.replace(
        '| `type="image"` | M3.1-Flash-Preview / M3 only |',
        `| \`type="image"\` | ${status} |`,
      )
      expect(page).not.toBe(MINIMAX_SDK_PAGE)
      return parseMinimaxInputModalities(page, IDS)
    }
    for (const status of [
      'Not supported on M2.x',
      'M2.7 not supported',
      'All models except M2.7',
      'M3.1-Flash-Preview / M3',
      'M2.x only',
      'M9 only',
      'Partial support',
    ]) {
      expect(en(status).size).toBe(0)
    }
    expect(en('M3 only').get('MiniMax-M3.1-Flash-Preview')).toEqual([
      'text',
      'video',
    ])

    const cn = (status: string) => {
      const page = MINIMAX_CN_SDK_PAGE.replace(
        '| `type="image"` | 仅 M3.1-Flash-Preview / M3 |',
        `| \`type="image"\` | ${status} |`,
      )
      expect(page).not.toBe(MINIMAX_CN_SDK_PAGE)
      return parseMinimaxInputModalities(page, IDS, MINIMAX_CN)
    }
    for (const status of [
      '仅 M2.x 不支持',
      '仅 M2.7 不支持',
      '仅 M2.x',
      '仅 M9',
      '只支持 M3.1-Flash-Preview / M3',
      'M3.1-Flash-Preview / M3 专属',
    ]) {
      expect(cn(status).size).toBe(0)
    }
    expect(cn('仅 M3').get('MiniMax-M3.1-Flash-Preview')).toEqual([
      'text',
      'video',
    ])
  })

  it('stores no reasoning for a disabled cell that only mentions the phrase', () => {
    const en = MINIMAX_SDK_PAGE.replace(
      '| Thinking stays off |',
      '| Can be turned off (unlike M2.x, where thinking cannot be disabled) |',
    ).replace(
      '| Accepted but ignored; thinking remains on |',
      '| Thinking can be switched off |',
    )
    expect([...parseMinimaxReasoning(en, IDS).keys()]).toEqual([
      'MiniMax-M3.1-Flash-Preview',
    ])
    const cn = MINIMAX_CN_SDK_PAGE.replace(
      '| 保持 thinking 关闭 |',
      '| 可关闭（不同于 M2.x 的 thinking 无法关闭） |',
    ).replace(
      '| 被接收但不生效，thinking 仍保持开启 |',
      '| 可以关闭 thinking |',
    )
    expect([...parseMinimaxReasoning(cn, IDS, MINIMAX_CN).keys()]).toEqual([
      'MiniMax-M3.1-Flash-Preview',
    ])
  })
})

describe('fetchMinimaxPage', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function answerFrom(finalUrl: string): void {
    globalThis.fetch = () => {
      const response = new Response('{}')
      Object.defineProperty(response, 'url', { value: finalUrl })
      return Promise.resolve(response)
    }
  }

  it('follows the China redirect and refuses any other host', async () => {
    const url = MINIMAX_CN.chatSpecUrl
    answerFrom(url.replace('platform.minimaxi.com', 'platform.minimax.cn'))
    await expect(fetchMinimaxPage(url, MINIMAX_CN)).resolves.toBe('{}')
    answerFrom(url)
    await expect(fetchMinimaxPage(url, MINIMAX_CN)).resolves.toBe('{}')

    // The international platform publishes the same path.
    answerFrom(MINIMAX.chatSpecUrl)
    await expect(fetchMinimaxPage(url, MINIMAX_CN)).rejects.toThrow(
      'minimax-cn: https://platform.minimaxi.com/docs/api-reference/text/api/openapi-chat-openai.json was answered by platform.minimax.io',
    )
    answerFrom('https://platform.minimax.cn.example.com/docs/x.json')
    await expect(fetchMinimaxPage(url, MINIMAX_CN)).rejects.toThrow(
      'was answered by platform.minimax.cn.example.com',
    )
    answerFrom(url)
    await expect(
      fetchMinimaxPage(MINIMAX.chatSpecUrl, MINIMAX),
    ).rejects.toThrow('minimax: ')
  })
})

describe('a maximum equal to the context window is not an output cap', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  const PLATFORMS = [
    {
      platform: MINIMAX,
      sdk: MINIMAX_SDK_PAGE,
      pricing: MINIMAX_PRICING_PAGE,
      description: MINIMAX_MAX_COMPLETION_TOKENS,
    },
    {
      platform: MINIMAX_CN,
      sdk: MINIMAX_CN_SDK_PAGE,
      pricing: MINIMAX_CN_PRICING_PAGE,
      description: MINIMAX_CN_MAX_COMPLETION_TOKENS,
    },
  ]

  for (const { platform, sdk, pricing, description } of PLATFORMS) {
    const facts = (text: string) => {
      const pages: Record<string, string> = {
        [platform.sdkUrl]: sdk,
        [platform.pricingUrl]: pricing,
        [platform.chatSpecUrl]: JSON.stringify({
          max_completion_tokens: { description: text },
        }),
      }
      globalThis.fetch = ((url: string) =>
        Promise.resolve(new Response(pages[String(url)]))) as typeof fetch
      return minimaxModelFacts(undefined, platform)
    }

    it(`${platform.label}: stores no cap for the M2 rows, 524288 for M3`, async () => {
      const of = await facts(description)
      for (const id of IDS.slice(0, 2)) {
        expect(of(id).contextWindow).toBe(1_000_000)
        expect(of(id).maxOutput).toBe(524_288)
        expect(of(id).factSources?.maxOutput?.sourceUrl).toBe(
          platform.chatSpecUrl,
        )
      }
      expect(IDS.slice(2)).toHaveLength(7)
      for (const id of IDS.slice(2)) {
        expect(of(id).contextWindow).toBe(204_800)
        expect(of(id).maxOutput).toBeNull()
        expect(of(id).factSources?.maxOutput).toBeUndefined()
      }
    })

    it(`${platform.label}: stores an M2 cap that differs from the window`, async () => {
      const of = await facts(description.replace('204800', '131072'))
      for (const id of IDS.slice(2)) {
        expect(of(id).maxOutput).toBe(131_072)
        expect(of(id).factSources?.maxOutput?.sourceUrl).toBe(
          platform.chatSpecUrl,
        )
      }
      expect(of('MiniMax-M3').maxOutput).toBe(524_288)
    })
  }
})
