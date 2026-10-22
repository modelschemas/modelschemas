import { describe, expect, it } from 'vitest'

import {
  MINIMAX_CN_PRICING_LLM_MDX,
  MINIMAX_PRICING_AUDIO_MDX,
  MINIMAX_PRICING_LLM_MDX,
  minimaxPricingHtml,
} from './fixtures/minimax-docs.ts'
import { MINIMAX, MINIMAX_CN, parseMinimaxPricing } from './minimax-docs.ts'
import type { MinimaxPlatform } from './minimax-docs.ts'
import { minimaxPricingSection } from './minimax-pricing-mdx.ts'

const section = (html: string, platform: MinimaxPlatform = MINIMAX) =>
  minimaxPricingSection(html, platform.priceSection, platform.label)
const prices = (html: string, platform: MinimaxPlatform = MINIMAX) =>
  parseMinimaxPricing(section(html, platform), platform)

const EN = minimaxPricingHtml(
  MINIMAX_PRICING_LLM_MDX,
  MINIMAX_PRICING_AUDIO_MDX,
)

describe('minimaxPricingSection', () => {
  it('prices the 2026-10-21 page: M3.1-Flash, and M3 at the standard tier', () => {
    expect([...prices(EN)]).toEqual([
      [
        'MiniMax-M3.1-Flash',
        {
          base: {
            input_tokens: 0.15 / 1e6,
            output_tokens: 0.6 / 1e6,
            cache_read_tokens: 0.015 / 1e6,
          },
          tiers: [],
        },
      ],
      [
        'MiniMax-M3',
        {
          // The billed price under the permanent badge, not the struck
          // $0.60 or the Priority tab's $0.45.
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
        },
      ],
    ])
  })

  it('prices the China page in yuan', () => {
    const cn = prices(
      minimaxPricingHtml(MINIMAX_CN_PRICING_LLM_MDX),
      MINIMAX_CN,
    )
    expect(cn.get('MiniMax-M3.1-Flash')?.base).toEqual({
      input_tokens: 1 / 1e6,
      output_tokens: 4 / 1e6,
      cache_read_tokens: 0.1 / 1e6,
    })
    expect(cn.get('MiniMax-M3')?.base.input_tokens).toBe(2.1 / 1e6)
    expect(cn.get('MiniMax-M3')?.tiers[0]?.rates.input_tokens).toBe(4.2 / 1e6)
  })

  it('keeps each tab a tab, the struck price, and the badge', () => {
    const mdx = section(EN)
    expect(mdx).toContain('<Tab title="Standard">')
    expect(mdx).toContain('<Tab title="Priority*">')
    expect(mdx).toContain('| ~~$0.60~~ $0.30 |')
    expect(mdx).toMatch(/<span className="[^"]*">Permanent 50% off<\/span>/)
    expect(mdx).toContain('> 512k input tokens\\*')
  })

  it('refuses M3 when its badge stops saying permanent', () => {
    const promo = EN.replaceAll('Permanent 50% off', '50% off until Dec 31')
    expect(promo).not.toBe(EN)
    expect(prices(promo).has('MiniMax-M3')).toBe(false)
  })

  it('stops at the next level-2 heading', () => {
    expect(section(EN)).not.toContain('MiniMax-M9')
    // A heading in the same parent, not a sibling <section>, ends it too.
    const batch = MINIMAX_PRICING_AUDIO_MDX.replace(
      /^_jsxs\(`section`,\{id:`models\/speech`,className:`pricing-section`,children:\[/,
      '',
    ).replace(/\]\}\)$/, '')
    const inline = minimaxPricingHtml(
      MINIMAX_PRICING_LLM_MDX.replace(/\]\}\)$/, `,${batch}]})`),
    )
    expect(inline).not.toBe(minimaxPricingHtml(MINIMAX_PRICING_LLM_MDX))
    expect(inline).toContain('MiniMax-M9')
    expect(section(inline)).not.toContain('MiniMax-M9')
    expect(prices(inline).size).toBe(2)
  })

  it('refuses a section that loses its tabs', () => {
    // Without the tab boundary both tiers would price M3 twice.
    const flat = EN.replace(
      /\(Tab,\{title:`[^`]*`,id:`[^`]*`,/g,
      '(_Fragment,{',
    )
    expect(flat).not.toBe(EN)
    expect(flat).not.toContain('(Tab,')
    expect(prices(flat).has('MiniMax-M3')).toBe(false)
  })

  it('throws on an element it does not read', () => {
    const custom = EN.replace('_jsxs(Tabs,', '_jsxs(PriceTabs,')
    expect(custom).not.toBe(EN)
    expect(() => section(custom)).toThrow('minimax: <PriceTabs>')
  })

  it('throws on a row a style could strike or hide', () => {
    const struck = EN.replace(
      '_jsxs(_components.tr,{children:',
      '_jsxs(_components.tr,{style:{textDecoration:`line-through`},children:',
    )
    expect(struck).not.toBe(EN)
    expect(() => section(struck)).toThrow('minimax: <tr> style')
    const span = EN.replace(
      'style:{whiteSpace:`nowrap`}',
      'style:{textDecoration:`line-through`}',
    )
    expect(span).not.toBe(EN)
    expect(() => section(span)).toThrow('<span> props')
  })

  it('throws on a table inside a list item, where its rows would lose their place', () => {
    const start = EN.indexOf('_jsxs(Table,{children:[')
    const end = EN.indexOf(',_jsxs(Tabs,')
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    const table = EN.slice(start, end)
    const listed = EN.replace(
      table,
      `_jsx(_components.ul,{children:_jsx(_components.li,{children:${table}})})`,
    )
    expect(listed).not.toBe(EN)
    expect(() => section(listed)).toThrow('<Table> inside inline content')
  })

  it('throws on a `|` in a cell, which would shift the columns', () => {
    const piped = EN.replace('children:`$0.15`', 'children:`$0.15 | $0.10`')
    expect(piped).not.toBe(EN)
    expect(() => section(piped)).toThrow('a `|` in a cell')
  })

  it('throws on a heading level it cannot render', () => {
    const level = minimaxPricingHtml(
      MINIMAX_PRICING_LLM_MDX.replace(
        '_jsx(_components.p,',
        '_jsx(Heading,{level:`0`,id:`batch`,children:`Batch`}),_jsx(_components.p,',
      ),
    )
    expect(level).toContain('level:`0`')
    expect(() => section(level)).toThrow('<Heading> level')
  })

  it('throws on a span that is neither layout nor a badge', () => {
    const span = EN.replace(
      'style:{whiteSpace:`nowrap`}',
      'title:`list price`,style:{whiteSpace:`nowrap`}',
    )
    expect(span).not.toBe(EN)
    expect(() => section(span)).toThrow('<span> props')
  })

  it('throws unless the heading is there once', () => {
    expect(() =>
      section(minimaxPricingHtml(MINIMAX_PRICING_AUDIO_MDX)),
    ).toThrow('minimax: 0 "## LLM" headings, not one')
    expect(() =>
      section(
        minimaxPricingHtml(MINIMAX_PRICING_LLM_MDX, MINIMAX_PRICING_LLM_MDX),
      ),
    ).toThrow('minimax: 2 "## LLM" headings, not one')
  })

  it('throws when the page has no compiled MDX body', () => {
    expect(() => section('<!DOCTYPE html><html></html>')).toThrow(
      'minimax: page has no compiled MDX body',
    )
  })
})
