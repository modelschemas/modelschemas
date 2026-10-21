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
  })

  it('refuses a section that loses its tabs', () => {
    // Without the tab boundary both tiers would price M3 twice.
    const flat = EN.replaceAll('(Tab,{title:', '(_Fragment,{title:')
    expect(flat).not.toBe(EN)
    expect(prices(flat).has('MiniMax-M3')).toBe(false)
  })

  it('throws on an element it does not read', () => {
    const custom = EN.replace('_jsxs(Tabs,', '_jsxs(PriceTabs,')
    expect(custom).not.toBe(EN)
    expect(() => section(custom)).toThrow('minimax: <PriceTabs>')
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
