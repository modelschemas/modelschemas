import { describe, expect, it } from 'vitest'

import { priceDetailed } from './evaluate.ts'
import { compileTokenCard } from './token-card.ts'
import { normalizeUsage, usageFormat } from './usage.ts'

const source = {
  url: 'https://example.test/pricing',
  hash: 'a'.repeat(64),
  extractedAt: '2026-10-15T00:00:00Z',
}

const card = (rates: Record<string, number>) => {
  const compiled = compileTokenCard(rates, [], source)
  if (!compiled) throw new Error('no card')
  return compiled
}

// gpt-5: $1.25 in, $0.125 cached in, $10 out per 1M.
const GPT_5 = card({
  input_tokens: 1.25e-6,
  cache_read_tokens: 0.125e-6,
  output_tokens: 10e-6,
})

// Claude: $5 in, $6.25 5m writes, $10 1h writes, $0.5 hits, $25 out per 1M.
const CLAUDE = card({
  input_tokens: 5e-6,
  cache_write_tokens: 6.25e-6,
  cache_write_1h_tokens: 10e-6,
  cache_read_tokens: 0.5e-6,
  output_tokens: 25e-6,
})

const amount = (c: typeof GPT_5, usage: Record<string, unknown>) =>
  priceDetailed(c, {}, normalizeUsage(c, usage)).amount

describe('normalizeUsage', () => {
  it('subtracts OpenAI Responses cached tokens from input', () => {
    const usage = {
      input_tokens: 12_000,
      input_tokens_details: { cached_tokens: 4000 },
      output_tokens: 800,
      output_tokens_details: { reasoning_tokens: 300 },
      total_tokens: 12_800,
    }
    expect(usageFormat(GPT_5, usage)).toBe('openai-responses')
    expect(normalizeUsage(GPT_5, usage)).toEqual({
      input_tokens: 8000,
      cache_read_tokens: 4000,
      output_tokens: 800,
    })
    // 8000 × 1.25/M + 4000 × 0.125/M + 800 × 10/M
    expect(amount(GPT_5, usage)).toBeCloseTo(0.0185, 10)
  })

  it('subtracts OpenAI cache writes from the prompt total', () => {
    // Writes bill at 1.25× input: 1.25e-6 × 1.25.
    const priced = card({
      input_tokens: 1.25e-6,
      cache_read_tokens: 0.125e-6,
      cache_write_tokens: 1.5625e-6,
      output_tokens: 10e-6,
    })
    const usage = {
      input_tokens: 10_000,
      input_tokens_details: { cached_tokens: 4000, cache_write_tokens: 2000 },
      output_tokens: 100,
    }
    expect(normalizeUsage(priced, usage)).toEqual({
      input_tokens: 4000,
      cache_read_tokens: 4000,
      cache_write_tokens: 2000,
      output_tokens: 100,
    })
    // 4000×1.25 + 4000×0.125 + 2000×1.5625 + 100×10, per 1M
    expect(amount(priced, usage)).toBeCloseTo(0.009625, 10)
    const chat = {
      prompt_tokens: 10_000,
      prompt_tokens_details: { cached_tokens: 4000, cache_write_tokens: 2000 },
      completion_tokens: 100,
    }
    expect(normalizeUsage(priced, chat)).toEqual({
      input_tokens: 4000,
      cache_read_tokens: 4000,
      cache_write_tokens: 2000,
      output_tokens: 100,
    })
    // A zero write is not a lever. A write the card does not price is refused.
    expect(
      normalizeUsage(GPT_5, {
        ...usage,
        input_tokens_details: { cached_tokens: 4000, cache_write_tokens: 0 },
      }),
    ).toEqual({
      input_tokens: 6000,
      cache_read_tokens: 4000,
      output_tokens: 100,
    })
    expect(() =>
      priceDetailed(
        GPT_5,
        {},
        normalizeUsage(GPT_5, {
          input_tokens: 100,
          input_tokens_details: { cache_write_tokens: 40 },
          output_tokens: 10,
        }),
      ),
    ).toThrow(expect.objectContaining({ code: 'unknown-usage-key' }))
  })

  it('subtracts OpenAI Chat cached tokens from prompt tokens', () => {
    const usage = {
      prompt_tokens: 12_000,
      completion_tokens: 800,
      total_tokens: 12_800,
      prompt_tokens_details: { cached_tokens: 4000, audio_tokens: 0 },
      completion_tokens_details: {
        reasoning_tokens: 300,
        audio_tokens: 0,
        accepted_prediction_tokens: 0,
        rejected_prediction_tokens: 0,
      },
    }
    expect(usageFormat(GPT_5, usage)).toBe('openai-chat')
    expect(amount(GPT_5, usage)).toBeCloseTo(0.0185, 10)
  })

  it('splits reasoning out of output only when the card prices it', () => {
    const usage = {
      prompt_tokens: 100,
      completion_tokens: 50,
      completion_tokens_details: { reasoning_tokens: 30 },
    }
    expect(normalizeUsage(GPT_5, usage)).toEqual({
      input_tokens: 100,
      output_tokens: 50,
    })
    const reasoning = card({
      input_tokens: 1e-6,
      output_tokens: 2e-6,
      reasoning_tokens: 3e-6,
    })
    expect(normalizeUsage(reasoning, usage)).toEqual({
      input_tokens: 100,
      output_tokens: 20,
      reasoning_tokens: 30,
    })
  })

  it('maps Anthropic cache reads and writes, split by TTL', () => {
    const usage = {
      input_tokens: 1000,
      cache_read_input_tokens: 1_000_000,
      cache_creation_input_tokens: 3000,
      cache_creation: {
        ephemeral_5m_input_tokens: 1000,
        ephemeral_1h_input_tokens: 2000,
      },
      output_tokens: 400,
      service_tier: 'standard',
    }
    expect(usageFormat(CLAUDE, usage)).toBe('anthropic')
    expect(normalizeUsage(CLAUDE, usage)).toEqual({
      input_tokens: 1000,
      cache_read_tokens: 1_000_000,
      cache_write_tokens: 1000,
      cache_write_1h_tokens: 2000,
      output_tokens: 400,
    })
    // 1000 × 5 + 1M × 0.5 + 1000 × 6.25 + 2000 × 10 + 400 × 25, per 1M
    expect(amount(CLAUDE, usage)).toBeCloseTo(0.54125, 10)
  })

  it('maps Gemini usageMetadata, thoughts billed as output', () => {
    const usage = {
      promptTokenCount: 12_000,
      cachedContentTokenCount: 4000,
      candidatesTokenCount: 500,
      thoughtsTokenCount: 300,
      totalTokenCount: 12_800,
      promptTokensDetails: [{ modality: 'TEXT', tokenCount: 12_000 }],
      cacheTokensDetails: [{ modality: 'TEXT', tokenCount: 4000 }],
    }
    expect(usageFormat(GPT_5, usage)).toBe('gemini')
    expect(normalizeUsage(GPT_5, usage)).toEqual({
      input_tokens: 8000,
      cache_read_tokens: 4000,
      output_tokens: 800,
    })
  })

  it('splits Gemini audio only when the card prices audio', () => {
    const usage = {
      promptTokenCount: 1000,
      candidatesTokenCount: 10,
      promptTokensDetails: [
        { modality: 'TEXT', tokenCount: 400 },
        { modality: 'AUDIO', tokenCount: 600 },
      ],
    }
    expect(normalizeUsage(GPT_5, usage)).toEqual({
      input_tokens: 1000,
      cache_read_tokens: 0,
      output_tokens: 10,
    })
    const audio = card({
      input_tokens: 1e-6,
      audio_tokens: 3e-6,
      output_tokens: 2e-6,
    })
    expect(normalizeUsage(audio, usage)).toEqual({
      input_tokens: 400,
      audio_tokens: 600,
      output_tokens: 10,
    })
  })

  it('passes card levers through unchanged', () => {
    const usage = { input_tokens: 8000, cache_read_tokens: 4000 }
    expect(usageFormat(GPT_5, usage)).toBe('card')
    expect(normalizeUsage(GPT_5, usage)).toBe(usage)
  })

  it('reads a native key as a card lever when the card reads it', () => {
    const video = card({ completion_tokens: 2.5e-6 })
    expect(usageFormat(video, { completion_tokens: 1000 })).toBe('card')
    expect(usageFormat(GPT_5, { completion_tokens: 1000 })).toBe('openai-chat')
    expect(usageFormat(GPT_5, { input_tokens: 1, total_tokens: 1 })).toBe(
      'card',
    )
  })

  it('refuses a payload that mixes native fields and card levers', () => {
    const mixed = () =>
      normalizeUsage(GPT_5, {
        input_tokens: 12_000,
        input_tokens_details: { cached_tokens: 4000 },
        cache_read_tokens: 4000,
      })
    expect(mixed).toThrow(expect.objectContaining({ code: 'mixed-usage' }))
    expect(mixed).toThrow(
      'usage.cache_read_tokens: not a field of openai-responses usage',
    )
    expect(() =>
      normalizeUsage(CLAUDE, { prompt_tokens: 10, cache_read_input_tokens: 5 }),
    ).toThrow(expect.objectContaining({ code: 'mixed-usage' }))
  })

  it('refuses a cache count the card does not price', () => {
    const plain = card({ input_tokens: 1e-6, output_tokens: 2e-6 })
    const usage = {
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 40 },
      output_tokens: 10,
    }
    expect(normalizeUsage(plain, usage)).toEqual({
      input_tokens: 60,
      cache_read_tokens: 40,
      output_tokens: 10,
    })
    expect(() =>
      priceDetailed(plain, {}, normalizeUsage(plain, usage)),
    ).toThrow(expect.objectContaining({ code: 'unknown-usage-key' }))
  })

  it('refuses a native usage object that omits a format total', () => {
    expect(() => normalizeUsage(GPT_5, { completion_tokens: 1000 })).toThrow(
      /prompt_tokens/,
    )
    expect(() =>
      normalizeUsage(GPT_5, {
        input_tokens: 10,
        input_tokens_details: { cached_tokens: 0 },
      }),
    ).toThrow(/output_tokens/)
    expect(() =>
      normalizeUsage(CLAUDE, { output_tokens: 10, cache_read_input_tokens: 5 }),
    ).toThrow(/input_tokens/)
    expect(() => normalizeUsage(GPT_5, { candidatesTokenCount: 10 })).toThrow(
      /promptTokenCount/,
    )
    expect(
      normalizeUsage(GPT_5, {
        input_tokens: 0,
        output_tokens: 0,
        input_tokens_details: { cache_write_tokens: 0 },
      }),
    ).toEqual({ input_tokens: 0, output_tokens: 0 })
  })

  it('refuses counts that are not token counts or do not add up', () => {
    expect(() =>
      normalizeUsage(GPT_5, {
        input_tokens: 10,
        input_tokens_details: { cached_tokens: 40 },
      }),
    ).toThrow(expect.objectContaining({ code: 'bad-input' }))
    expect(() =>
      normalizeUsage(GPT_5, { prompt_tokens: '10', completion_tokens: 1 }),
    ).toThrow(expect.objectContaining({ code: 'bad-input' }))
  })

  it('keeps Chat image tokens in the prompt total unless the card prices them', () => {
    const usage = {
      prompt_tokens: 10,
      prompt_tokens_details: { image_tokens: 4, text_tokens: 6 },
      completion_tokens: 1,
    }
    // text_tokens is already inside prompt_tokens, so it is not subtracted.
    expect(normalizeUsage(GPT_5, usage)).toEqual({
      input_tokens: 10,
      output_tokens: 1,
    })
    const priced = card({
      input_tokens: 1e-6,
      image_tokens: 2e-6,
      output_tokens: 1e-6,
    })
    expect(normalizeUsage(priced, usage)).toEqual({
      input_tokens: 6,
      image_tokens: 4,
      output_tokens: 1,
    })
  })
})
