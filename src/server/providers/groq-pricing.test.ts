import { describe, expect, it } from 'vitest'

import { parseGroqPrice, parseGroqPricing } from './groq-pricing.ts'

const PAGE = `# Supported Models

| MODEL ID | SPEED | PRICE PER 1M TOKENS | RATE LIMITS |
| --- | --- | --- | --- |
| [![OpenAI](logo.svg)GPT OSS 120B](/docs/model/openai/gpt-oss-120b)openai/gpt-oss-120b | 500 | $0.15 input$0.60 output | 250K TPM |
| [![Meta](logo.png)Llama 3.1 8B](/docs/model/llama-3.1-8b-instant)Enterprisellama-3.1-8b-instant | 560 | ContactSales | ContactSales |
| [![OpenAI](logo.svg)Whisper](/docs/model/whisper-large-v3)whisper-large-v3 | - | $0.111 per hour | 200K ASH |
| [![Canopy](logo.png)Orpheus](/docs/model/canopylabs/orpheus-v1-english)canopylabs/orpheus-v1-english | - | $22.00 per 1M characters | 50K TPM |
| [![Alibaba](logo.png)Qwen](/docs/model/qwen/qwen3.8-27b)qwen/qwen3.8-27b | 450 | $0.80 input$4.00 output | 250K TPM |
| [![Mystery](logo.svg)New](/docs/model/new)new-model | - | $1 per request | - |
`

describe('groq models page', () => {
  it('reads token, hour, and character prices and skips unpublished ones', () => {
    const rates = parseGroqPricing(PAGE)
    expect(rates.get('openai/gpt-oss-120b')).toEqual({
      kind: 'tokens',
      rates: { input_tokens: 0.15e-6, output_tokens: 0.6e-6 },
    })
    expect(rates.get('qwen/qwen3.8-27b')).toEqual({
      kind: 'tokens',
      rates: { input_tokens: 0.8 / 1e6, output_tokens: 4 / 1e6 },
    })
    expect(rates.get('whisper-large-v3')).toEqual({
      kind: 'unit',
      unit: {
        quantity: { param: 'audio_seconds', bound: 'usage' },
        rates: 0.111 / 3600,
      },
    })
    expect(rates.get('canopylabs/orpheus-v1-english')).toEqual({
      kind: 'unit',
      unit: {
        quantity: { param: 'characters', bound: 'usage' },
        rates: 22 / 1e6,
      },
    })
    expect(rates.has('llama-3.1-8b-instant')).toBe(false)
    expect(rates.has('new-model')).toBe(false)
    expect(parseGroqPrice('$1 per request')).toBe('refuse')
  })
})
