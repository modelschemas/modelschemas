import { describe, expect, it } from 'vitest'

import {
  MINIMAX_MAX_COMPLETION_TOKENS,
  MINIMAX_PRICING_PAGE,
  MINIMAX_SDK_PAGE,
} from './fixtures/minimax-docs.ts'
import {
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
