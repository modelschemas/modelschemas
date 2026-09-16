import { describe, expect, it } from 'vitest'

import { anthropicCapabilities } from './anthropic.ts'
import { parseAnthropicPricing } from './anthropic-pricing.ts'
import { parseGeminiPricing } from './gemini-pricing.ts'
import { geminiCapabilities } from './gemini.ts'
import { grokRateCard, parseGrokContextWindows } from './grok.ts'
import { markdownTableRows, tokenCount, undatedId } from './model-facts.ts'
import { price } from '@modelschemas/rate-card'
import { openAiCompatModelFacts } from './openai-compat.ts'
import {
  pageSlugFor,
  parseModelIndex,
  parseModelPage,
  parseModelPricing,
} from './openai-model-docs.ts'

describe('model-facts helpers', () => {
  it('parses token counts with separators and k/M suffixes', () => {
    expect(tokenCount('1,048,576')).toBe(1_048_576)
    expect(tokenCount('500k')).toBe(500_000)
    expect(tokenCount('1M')).toBe(1_000_000)
  })

  it('strips snapshot dates', () => {
    expect(undatedId('gpt-5-2025-08-07')).toBe('gpt-5')
    expect(undatedId('claude-opus-4-5-20251101')).toBe('claude-opus-4-5')
    expect(undatedId('grok-4.20-0309-reasoning')).toBe(
      'grok-4.20-0309-reasoning',
    )
  })

  it('splits markdown table rows and drops separators', () => {
    expect(
      markdownTableRows('| a | b |\n| --- | ---: |\n| 1 | 2 |\ntext'),
    ).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })
})

describe('anthropic models api', () => {
  it('derives request features only from the capability tree', () => {
    expect(
      anthropicCapabilities({
        id: 'claude-fable-5-1',
        capabilities: {
          thinking: { supported: true },
          effort: { supported: true },
          structured_outputs: { supported: true },
        },
      }),
    ).toEqual([
      'reasoning',
      'reasoning_effort',
      'structured_outputs',
      'response_format',
    ])
    expect(
      anthropicCapabilities({ id: 'claude-x', capabilities: {} }),
    ).toBeNull()
  })
})

describe('gemini models api', () => {
  it('derives request features only from row fields', () => {
    expect(
      geminiCapabilities({ thinking: true, temperature: 1, topP: 0.95 }),
    ).toEqual(['reasoning', 'temperature', 'top_p'])
    expect(geminiCapabilities({})).toBeNull()
  })
})

describe('xai model docs', () => {
  it('reads context windows and ignores the per-image table', () => {
    const md = `
| Model | Context | Input / 1M tokens | Cached input / 1M tokens | Output / 1M tokens |
| --- | --- | --- | --- | --- |
| grok-4.6 (< 200k prompt tokens) | 500k | $2.00 | $0.50 | $6.00 |
| grok-4.6 (≥ 200k prompt tokens) | 500k | $4.00 | $1.00 | $12.00 |
| grok-4.3 (< 200k prompt tokens) | 1M | $1.25 | $0.20 | $2.50 |

| Model | Cost |
| --- | --- |
| grok-imagine-image | $0.02 / image |
`
    expect([...parseGrokContextWindows(md)]).toEqual([
      ['grok-4.6', 500_000],
      ['grok-4.3', 1_000_000],
    ])
  })
})

describe('openai model docs', () => {
  const page = `# GPT-5

Model ID: \`gpt-5\`

Reasoning.effort supports: minimal, low, medium, and high.

## Model details

- Default snapshot: \`gpt-5-2025-08-07\`
- Input modalities: text, image
- Output modalities: text
- 400,000 context window
- Maximum input tokens: 272,000
- 128,000 max output tokens
- Reasoning token support

## Supported features

- streaming
- structured_outputs
- function_calling

## Snapshots

- \`gpt-5-2025-08-07\`
- \`gpt-5-2025-09-01\`

## Rate limits
`
  it('parses details, features, snapshots', () => {
    const parsed = parseModelPage(page)
    expect(parsed?.ids).toEqual([
      'gpt-5',
      'gpt-5-2025-08-07',
      'gpt-5-2025-09-01',
    ])
    expect(parsed?.facts).toEqual({
      contextWindow: 400_000,
      maxOutput: 128_000,
      modalities: { input: ['text', 'image'], output: ['text'] },
      capabilities: [
        'tools',
        'reasoning',
        'structured_outputs',
        'response_format',
      ],
    })
  })

  it('resolves listed ids to index slugs, dated snapshots via the alias', () => {
    const slugs = parseModelIndex(
      '- [GPT-5](/api/docs/models/gpt-5.md): x\n- [Whisper](/api/docs/models/whisper-1.md): y',
    )
    expect(pageSlugFor('gpt-5-2025-08-07', slugs)).toBe('gpt-5')
    expect(pageSlugFor('whisper-1', slugs)).toBe('whisper-1')
    expect(pageSlugFor('gpt-5-search-api', slugs)).toBeNull()
  })
})

describe('openai-compatible model rows', () => {
  it('maps the extension fields groq/jina/fireworks/moonshot/mistral publish', () => {
    expect(
      openAiCompatModelFacts({
        id: 'openai/gpt-oss-120b',
        context_window: 131072,
        max_completion_tokens: 65536,
        input_modalities: ['text'],
        output_modalities: ['text'],
        supported_sampling_parameters: ['temperature', 'top_p', 'stop'],
        supported_features: [
          'tools',
          'json_mode',
          'structured_outputs',
          'reasoning',
        ],
      }),
    ).toEqual({
      contextWindow: 131072,
      maxOutput: 65536,
      modalities: { input: ['text'], output: ['text'] },
      capabilities: [
        'tools',
        'reasoning',
        'temperature',
        'top_p',
        'structured_outputs',
        'response_format',
      ],
    })
    expect(
      openAiCompatModelFacts({
        id: 'kimi-k2.6',
        context_length: 262144,
        supports_reasoning: true,
      }),
    ).toEqual({ contextWindow: 262144, capabilities: ['reasoning'] })
    expect(
      openAiCompatModelFacts({
        id: 'mistral-large-latest',
        max_context_length: 262144,
        capabilities: {
          function_calling: true,
          vision: true,
          reasoning: false,
        },
      }),
    ).toEqual({ contextWindow: 262144, capabilities: ['tools'] })
    expect(openAiCompatModelFacts({ id: 'x', max_output_length: 0 })).toEqual(
      {},
    )
  })
})

describe('openai-compatible model rows (novita / cohere vocab)', () => {
  it('normalises hyphenated features and cohere feature names', () => {
    expect(
      openAiCompatModelFacts({
        id: 'zai-org/glm-5.3-flash',
        context_size: 1_048_576,
        max_output_tokens: 131_072,
        input_modalities: ['text', 'image', 'video'],
        output_modalities: ['text'],
        features: ['function-calling', 'structured-outputs', 'reasoning'],
      }),
    ).toEqual({
      contextWindow: 1_048_576,
      maxOutput: 131_072,
      modalities: { input: ['text', 'image', 'video'], output: ['text'] },
      capabilities: [
        'tools',
        'reasoning',
        'structured_outputs',
        'response_format',
      ],
    })
    expect(
      openAiCompatModelFacts({
        id: 'command-a-03-2025',
        context_length: 288_000,
        features: ['json_mode', 'json_schema', 'tools', 'tool_choice'],
      }),
    ).toEqual({
      contextWindow: 288_000,
      capabilities: [
        'tools',
        'tool_choice',
        'structured_outputs',
        'response_format',
      ],
    })
  })
})

describe('openai pricing tables', () => {
  const pricing = (body: string) =>
    `# Model\n\nModel ID: \`m\`\n\n## Pricing\n\n${body}\n## Endpoints\n`

  it('reads every token lever off the per-million tables', () => {
    expect(
      parseModelPricing(
        pricing(`### Text tokens

| Metric | Price | Unit |
| --- | ---: | --- |
| Input | $1.25 | 1M tokens |
| Cached input | $0.125 | 1M tokens |
| Output | $10 | 1M tokens |

### Audio tokens

| Metric | Price | Unit |
| --- | ---: | --- |
| Input | $32 | 1M tokens |
| Output | $64 | 1M tokens |
`),
      ),
    ).toEqual({
      rates: {
        input_tokens: 1.25e-6,
        cache_read_tokens: 0.125e-6,
        output_tokens: 10e-6,
        audio_tokens: 32e-6,
        audio_output_tokens: 64e-6,
      },
      tiers: [],
    })
  })

  it('reads an embeddings page', () => {
    expect(
      parseModelPricing(
        pricing(`### Embeddings

| Metric | Price | Unit |
| --- | ---: | --- |
| Cost | $0.02 | 1M tokens |
`),
      ),
    ).toEqual({ rates: { input_tokens: 0.02e-6 }, tiers: [] })
  })

  it('treats the per-image table as a restatement of the token price', () => {
    // OpenAI bills image models per token; the per-image table is the
    // equivalent cost of one image at a size and quality.
    expect(
      parseModelPricing(
        pricing(`### Image tokens

| Metric | Price | Unit |
| --- | ---: | --- |
| Input | $10 | 1M tokens |
| Output | $40 | 1M tokens |

### Image generation

| Metric | Price | Unit |
| --- | ---: | --- |
| Quality | Low | image |
| 1024x1024 | $0.011 | image |
`),
      ),
    ).toEqual({
      rates: { image_tokens: 10e-6, image_output_tokens: 40e-6 },
      tiers: [],
    })
  })

  it('refuses a section priced in a unit it has no lever for', () => {
    expect(
      parseModelPricing(
        pricing(`### Pricing

| Metric | Price | Unit |
| --- | ---: | --- |
| Cost | $0.10 | GB-hour |
`),
      ),
    ).toBeNull()
  })

  it('reads the long-prompt re-quote and cache-write multiplier', () => {
    const page = pricing(`### Text tokens

| Metric | Price | Unit |
| --- | ---: | --- |
| Input | $10 | 1M tokens |
| Cached input | $1 | 1M tokens |
| Output | $50 | 1M tokens |

- Prompts with more than 272K input tokens are priced at 2x input and cache rates and 1.5x output for the full request.
- Cache writes are billed at 1.25x the uncached input token rate.
- Batch and Flex are priced at 50% of Standard rates.
`)
    expect(parseModelPricing(page)).toEqual({
      rates: {
        input_tokens: 10e-6,
        cache_read_tokens: 1e-6,
        cache_write_tokens: 12.5e-6,
        output_tokens: 50e-6,
      },
      tiers: [
        {
          minPromptTokens: 272_000,
          rates: {
            input_tokens: 20e-6,
            cache_read_tokens: 2e-6,
            cache_write_tokens: 25e-6,
            output_tokens: (50 / 1e6) * 1.5,
          },
        },
      ],
    })
  })

  it('stamps a promo end so the card is re-read after it', () => {
    const page = pricing(`### Text tokens

| Metric | Price | Unit |
| --- | ---: | --- |
| Input | $4 | 1M tokens |
| Output | $20 | 1M tokens |

- GPT-5.6 Sol costs $4 per million input tokens and $20 per million output tokens, a 20% reduction in input pricing. GPT-5.6 Sol’s promotional pricing is available at least through November 21, 2026.
`)
    expect(parseModelPricing(page)?.expiresAt).toBe('2026-11-22T00:00:00.000Z')
  })

  it('prices a per-minute model by the duration the caller measures', () => {
    expect(
      parseModelPricing(
        pricing(`### Transcription audio duration

| Metric | Price | Unit |
| --- | ---: | --- |
| Price | $0.0045 | minute |
`),
      ),
    ).toEqual({
      rates: {},
      tiers: [],
      unit: {
        quantity: { param: 'audio_seconds', bound: 'usage' },
        rates: 0.0045 / 60,
      },
    })
  })

  it('prices speech by character and video by size and second', () => {
    expect(
      parseModelPricing(
        pricing(`### Pricing

| Metric | Price | Unit |
| --- | ---: | --- |
| Use case | Speech generation | 1M tokens |
| Cost | $15 | 1M characters |
`),
      )?.unit,
    ).toEqual({
      quantity: { param: 'characters', bound: 'usage' },
      rates: 15 / 1e6,
    })
    // A video row names both orientations of one size in its metric cell,
    // and the cell's newline splits the row across two lines.
    expect(
      parseModelPricing(
        pricing(`### Video generation

| Metric | Price | Unit |
| --- | ---: | --- |
| Portrait: 720x1280
Landscape: 1280x720 | $0.3 | second |
| Portrait: 1080x1920
Landscape: 1920x1080 | $0.7 | second |
`),
      )?.unit,
    ).toEqual({
      quantity: { param: 'seconds', bound: 'request' },
      keys: [
        {
          param: 'size',
          values: ['720x1280', '1280x720', '1080x1920', '1920x1080'],
        },
      ],
      rates: {
        '720x1280': 0.3,
        '1280x720': 0.3,
        '1080x1920': 0.7,
        '1920x1080': 0.7,
      },
    })
  })

  it('refuses a page that mixes a token table with a per-unit one', () => {
    expect(
      parseModelPricing(
        pricing(`### Text tokens

| Metric | Price | Unit |
| --- | ---: | --- |
| Input | $5 | 1M tokens |

### Live session duration

| Metric | Price | Unit |
| --- | ---: | --- |
| Per minute | $0.05 | minute |
`),
      ),
    ).toBeNull()
  })

  it('refuses an unrecognised bullet that quotes a surcharge', () => {
    const page = pricing(`### Text tokens

| Metric | Price | Unit |
| --- | ---: | --- |
| Input | $10 | 1M tokens |
| Output | $50 | 1M tokens |

- Requests using the widget tool are charged a 3x multiplier.
`)
    expect(parseModelPricing(page)).toBeNull()
  })

  it('refuses an unpriced row and a page with no pricing', () => {
    expect(
      parseModelPricing(
        pricing(`### Text tokens

| Metric | Price | Unit |
| --- | ---: | --- |
| Input | Free | 1M tokens |
`),
      ),
    ).toBeNull()
    expect(parseModelPricing('# Model\n\nModel ID: `m`\n')).toBeNull()
  })
})

describe('anthropic pricing page', () => {
  const page = `# Pricing

## Model pricing

| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |
| --- | --- | --- | --- | --- | --- |
| Claude Fable 5.1 | $10 / MTok | $12.50 / MTok | $20 / MTok | $0.25 / MTok1 | $50 / MTok |
| Claude Opus 4 ([retired](https://example.com/deprecations)) | $15 / MTok | $18.75 / MTok | $30 / MTok | $1.50 / MTok | $75 / MTok |

## Batch pricing

| Model | Batch input | Batch output |
| --- | --- | --- |
| Claude Fable 5.1 | $5 / MTok | $25 / MTok |
`

  it('keys rows by display name and reads every lever column', () => {
    const rows = parseAnthropicPricing(page)
    expect(rows.get('claude fable 5.1')).toEqual({
      input_tokens: 10e-6,
      cache_write_tokens: 12.5e-6,
      cache_write_1h_tokens: 20e-6,
      cache_read_tokens: 0.25e-6,
      output_tokens: 50e-6,
    })
    // The name cell's retirement link is not part of the key.
    expect(rows.get('claude opus 4')?.input_tokens).toBe(15e-6)
    // Batch rates live in another section and are not levers.
    expect(rows.size).toBe(2)
  })

  it('parses nothing when the section is gone', () => {
    expect(parseAnthropicPricing('# Pricing\n\n## Something else\n').size).toBe(
      0,
    )
  })
})

describe('grok model prices', () => {
  const model = {
    id: 'grok-4.20-0309-reasoning',
    prompt_text_token_price: 12_500,
    cached_prompt_text_token_price: 2_000,
    completion_text_token_price: 25_000,
    prompt_text_token_price_long_context: 25_000,
    cached_prompt_text_token_price_long_context: 4_000,
    completion_text_token_price_long_context: 50_000,
    long_context_threshold: 200_000,
  }

  it('reads xAI’s 1e-10 USD units as per-token rates', async () => {
    const card = await grokRateCard(model)
    if (!card) throw new Error('did not compile')
    expect(
      price(card, {}, { input_tokens: 1e5, output_tokens: 0 }),
    ).toBeCloseTo(0.125, 9)
    expect(
      price(card, {}, { input_tokens: 0, output_tokens: 1e5 }),
    ).toBeCloseTo(0.25, 9)
  })

  it('bills the long-context rate at the threshold, not above it', async () => {
    const card = await grokRateCard(model)
    if (!card) throw new Error('did not compile')
    const perMillion = (tokens: number) =>
      (price(card, {}, { input_tokens: tokens, output_tokens: 0 }) / tokens) *
      1e6
    expect(perMillion(199_999)).toBeCloseTo(1.25, 6)
    expect(perMillion(200_000)).toBeCloseTo(2.5, 6)
  })

  it('has no card for a model xAI does not price', async () => {
    expect(await grokRateCard({ id: 'grok-imagine-video' })).toBeNull()
  })
})

describe('gemini pricing page', () => {
  const section = (id: string, rows: string) => `<div class="models-section">
  <div class="heading-group"><h2 id="${id}">Name</h2>
  <em><a href="/gemini-api/docs/models/${id}"><code translate="no" dir="ltr">${id}</code></a></em></div>
  </div>
  <div><devsite-selector><section><h3 id="standard" data-text="Standard">Standard</h3><table class="pricing-table">
  <thead><tr><th></th><th scope="col">Free Tier</th><th scope="col">Paid Tier, per 1M tokens in USD</th></tr></thead>
  <tbody>${rows}</tbody></table></section>
  <section><h3 id="batch" data-text="Batch">Batch</h3><table class="pricing-table"><tbody>
  <tr><td>Input price</td><td>Not available</td><td>$0.15</td></tr>
  </tbody></table></section></devsite-selector></div>`

  const NOW = Date.UTC(2026, 8, 16)

  it('reads text and audio rates off the Standard table', () => {
    const rows = parseGeminiPricing(
      section(
        'gemini-2.5-flash',
        `<tr><td>Input price</td><td>Free of charge</td><td>$0.30 (text / image / video)<br>$1.00 (audio)</td></tr>
         <tr><td>Output price (including thinking tokens)</td><td>Free of charge</td><td>$2.50</td></tr>
         <tr><td>Context caching price</td><td>Not available</td><td>$0.03 (text / image / video)<br>$0.1 (audio)<br>$1.00 / 1,000,000 tokens per hour (storage price)</td></tr>
         <tr><td>Grounding with Google Search</td><td>Free</td><td>1,500 RPD (free), then $35 / 1,000 grounded prompts</td></tr>`,
      ),
      NOW,
    )
    expect(rows.get('gemini-2.5-flash')?.base).toEqual({
      input_tokens: 0.3e-6,
      audio_tokens: 1e-6,
      output_tokens: 2.5e-6,
      cache_read_tokens: 0.03e-6,
      audio_cache_tokens: 0.1 / 1e6,
    })
    // Batch is a separate tab, and cache storage is a per-hour rate.
    expect(rows.get('gemini-2.5-flash')?.tiers).toEqual([])
  })

  it('compiles the long-prompt re-quote as a tier', () => {
    const rows = parseGeminiPricing(
      section(
        'gemini-2.5-pro',
        `<tr><td>Input price</td><td>Free of charge</td><td>$1.25, prompts <= 200k tokens<br>$2.50, prompts > 200k tokens</td></tr>
         <tr><td>Output price (including thinking tokens)</td><td>Free of charge</td><td>$10.00, prompts <= 200k<br>$15.00, prompts > 200k</td></tr>`,
      ),
      NOW,
    )
    expect(rows.get('gemini-2.5-pro')?.base).toEqual({
      input_tokens: 1.25e-6,
      output_tokens: 10e-6,
    })
    expect(rows.get('gemini-2.5-pro')?.tiers).toEqual([
      {
        minPromptTokens: 200_000,
        rates: { input_tokens: 2.5e-6, output_tokens: 15e-6 },
      },
    ])
  })

  it('takes the dated price in effect and stamps its expiry', () => {
    const page = section(
      'gemini-3.8-flash',
      `<tr><td>Input price</td><td>Not available</td><td>$0.75 through December 31, 2026.<br>$1.50 starting January 1, 2027.</td></tr>
       <tr><td>Output price (including thinking tokens)</td><td>Not available</td><td>$3.75 through December 31, 2026.<br>$7.50 starting January 1, 2027.</td></tr>`,
    )
    expect(parseGeminiPricing(page, NOW).get('gemini-3.8-flash')).toEqual({
      base: { input_tokens: 0.75e-6, output_tokens: 3.75e-6 },
      tiers: [],
      expiresAt: '2027-01-01T00:00:00.000Z',
    })
    expect(
      parseGeminiPricing(page, Date.UTC(2027, 5, 1)).get('gemini-3.8-flash'),
    ).toEqual({
      base: { input_tokens: 1.5e-6, output_tokens: 7.5e-6 },
      tiers: [],
    })
  })

  it('gives a separately priced modality its own lever', () => {
    // Gemini sums text, image and video into one prompt-token count, so a
    // rate covering them all is the input lever; audio is priced apart.
    const rows = parseGeminiPricing(
      section(
        'gemini-3-pro-image',
        `<tr><td>Input price</td><td>Not available</td><td>$2.00 (text/image),<br>equivalent to $0.0011 per image</td></tr>
         <tr><td>Output price</td><td>Not available</td><td>$12.00 (text and thinking)<br>$120.00 (images)<br>Equivalent to $0.134 per 1K/2K image<br>and $0.24 per 4K image</td></tr>`,
      ),
      NOW,
    )
    // The per-image lines restate the token rate; they are not extra cost.
    expect(rows.get('gemini-3-pro-image')?.base).toEqual({
      input_tokens: 2e-6,
      output_tokens: 12e-6,
      image_output_tokens: 120e-6,
    })
  })

  it('reads a per-modality row and an audio-only rate', () => {
    const rows = parseGeminiPricing(
      section(
        'gemini-embedding-2',
        `<tr><td>Text input price</td><td>Not available</td><td>$0.20</td></tr>
         <tr><td>Image input price</td><td>Not available</td><td>$0.45 ($0.00012 per image)</td></tr>
         <tr><td>Audio input price</td><td>Not available</td><td>$6.50 ($0.00016 per second)</td></tr>`,
      ),
      NOW,
    )
    expect(rows.get('gemini-embedding-2')?.base).toEqual({
      input_tokens: 0.2 / 1e6,
      image_tokens: 0.45 / 1e6,
      audio_tokens: 6.5 / 1e6,
    })
  })

  it('refuses a model whose bill is not only tokens', () => {
    // A row priced per image (not a restatement of a token rate), a
    // modality the row has no lever for, and a priced row with no lever.
    const perImage = `<tr><td>Input price</td><td>Not available</td><td>$0.30 (text / image)</td></tr>
       <tr><td>Output price</td><td>Not available</td><td>$0.039 per image</td></tr>`
    const perSong = `<tr><td>Lyria 3.5 (Full Song)</td><td>Not available</td><td>$0.08 per song</td></tr>`
    const unknownModality = `<tr><td>Input price</td><td>Not available</td><td>$1.00 (hologram)</td></tr>`
    for (const rows of [perImage, perSong, unknownModality]) {
      expect(parseGeminiPricing(section('m', rows), NOW).size).toBe(0)
    }
  })
})
