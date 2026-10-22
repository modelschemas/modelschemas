import { describe, expect, it } from 'vitest'

import {
  parseGroqCachedInput,
  parseGroqCachingModels,
  parseGroqPrice,
  parseGroqPricing,
} from './groq-pricing.ts'

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
    const oss = rates.get('openai/gpt-oss-120b')
    expect(oss?.kind === 'tokens' ? oss.rates : {}).not.toHaveProperty(
      'cache_read_tokens',
    )
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

const CACHING = `# Prompt Caching

## [Supported Models](#supported-models)

| Model ID                     | Model                                                             |
| ---------------------------- | ----------------------------------------------------------------- |
| openai/gpt-oss-20b           | [GPT-OSS 20B](https://console.groq.com/docs/model/openai/gpt-oss-20b)                     |
| openai/gpt-oss-120b          | [GPT-OSS 120B](https://console.groq.com/docs/model/openai/gpt-oss-120b)                   |

We're starting with a limited selection of models.

## [Pricing](#pricing)

| Not | A model |
| --- | --- |
| x/y | z |
`

const MODEL_PAGE = `### PRICING

Input

$0.075

13M / $1

Cached Input

$0.037

27M / $1

Output

$0.30
`

describe('groq cached-input prices (#411)', () => {
  it('reads the Supported Models table only', () => {
    expect(parseGroqCachingModels(CACHING)).toEqual([
      'openai/gpt-oss-20b',
      'openai/gpt-oss-120b',
    ])
  })

  it('throws when the doc lists no caching model', () => {
    expect(() => parseGroqCachingModels('# Prompt Caching\n')).toThrow(
      /no Supported Models rows/,
    )
  })

  it("reads the model page's stated Cached Input price", () => {
    expect(parseGroqCachedInput(MODEL_PAGE, 'openai/gpt-oss-20b')).toBe(
      0.037 / 1e6,
    )
  })

  it('throws when a caching model page states no Cached Input price', () => {
    expect(() =>
      parseGroqCachedInput('Input\n\n$0.075\n\nOutput\n\n$0.30\n', 'm'),
    ).toThrow(/no Cached Input price/)
  })
})
