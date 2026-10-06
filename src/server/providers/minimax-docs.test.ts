import { describe, expect, it } from 'vitest'

import {
  MINIMAX_CN_MAX_COMPLETION_TOKENS,
  MINIMAX_CN_SDK_PAGE,
  MINIMAX_MAX_COMPLETION_TOKENS,
  MINIMAX_PRICING_PAGE,
  MINIMAX_SDK_PAGE,
} from './fixtures/minimax-docs.ts'
import {
  MINIMAX_CN,
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
