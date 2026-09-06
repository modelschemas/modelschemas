import { afterEach, describe, expect, it } from 'vitest'

import {
  factsFromModelsDev,
  modelFactsLookup,
  perTokenPrice,
  undatedId,
} from './model-facts.ts'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('factsFromModelsDev', () => {
  it('maps a models.dev entry onto OpenRouter-shaped catalog fields', () => {
    expect(
      factsFromModelsDev({
        reasoning: true,
        reasoning_options: [{ type: 'effort' }],
        tool_call: true,
        structured_output: true,
        temperature: false,
        modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
        limit: { context: 1_000_000, output: 128_000 },
        cost: { input: 10, output: 50, cache_read: 0.25, cache_write: 12.5 },
      }),
    ).toEqual({
      contextWindow: 1_000_000,
      maxOutput: 128_000,
      modalities: { input: ['text', 'image', 'file'], output: ['text'] },
      pricing: {
        prompt: '0.00001',
        completion: '0.00005',
        input_cache_read: '0.00000025',
        input_cache_write: '0.0000125',
      },
      capabilities: [
        'tools',
        'tool_choice',
        'reasoning',
        'reasoning_effort',
        'structured_outputs',
        'response_format',
      ],
    })
  })

  it('returns nulls for unknown models and empty sections', () => {
    expect(factsFromModelsDev(undefined)).toEqual({
      contextWindow: null,
      maxOutput: null,
      modalities: null,
      pricing: null,
      capabilities: null,
    })
    expect(factsFromModelsDev({ limit: { context: 16_000 } })).toMatchObject({
      contextWindow: 16_000,
      maxOutput: null,
      pricing: null,
      capabilities: null,
    })
  })

  it('formats per-token prices as plain decimals', () => {
    expect(perTokenPrice(3)).toBe('0.000003')
    expect(perTokenPrice(0.3)).toBe('0.0000003')
    expect(perTokenPrice(1.25)).toBe('0.00000125')
    expect(perTokenPrice(0)).toBe('0')
  })

  it('strips snapshot dates for the alias lookup', () => {
    expect(undatedId('gpt-5-2025-08-07')).toBe('gpt-5')
    expect(undatedId('claude-opus-4-5-20251101')).toBe('claude-opus-4-5')
    expect(undatedId('grok-4.20-0309-reasoning')).toBe(
      'grok-4.20-0309-reasoning',
    )
  })
})

describe('modelFactsLookup', () => {
  it('fetches models.dev once and resolves dated ids to aliases', async () => {
    let calls = 0
    globalThis.fetch = () => {
      calls++
      return Promise.resolve(
        new Response(
          JSON.stringify({
            openai: { models: { 'gpt-5': { limit: { context: 400_000 } } } },
            xai: { models: {} },
          }),
        ),
      )
    }
    const openai = await modelFactsLookup('openai')
    const xai = await modelFactsLookup('xai')
    expect(calls).toBe(1)
    expect(openai('gpt-5-2025-08-07').contextWindow).toBe(400_000)
    expect(openai('whisper-1').contextWindow).toBeNull()
    expect(xai('grok-4.6').contextWindow).toBeNull()
  })
})
