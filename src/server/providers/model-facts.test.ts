import { describe, expect, it } from 'vitest'

import { anthropicCapabilities, parseAnthropicPricing } from './anthropic.ts'
import {
  geminiCapabilities,
  geminiModalities,
  parseGeminiPricing,
} from './gemini.ts'
import { grokCapabilities, parseGrokContextWindows } from './grok.ts'
import {
  dollars,
  markdownTableRows,
  perTokenPrice,
  tokenCount,
  undatedId,
} from './model-facts.ts'
import {
  pageSlugFor,
  parseModelIndex,
  parseModelPage,
} from './openai-model-docs.ts'

describe('model-facts helpers', () => {
  it('formats per-token prices as plain decimals', () => {
    expect(perTokenPrice(3)).toBe('0.000003')
    expect(perTokenPrice(0.3)).toBe('0.0000003')
    expect(perTokenPrice(1.25)).toBe('0.00000125')
    expect(perTokenPrice(0)).toBe('0')
  })

  it('reads the first per-token dollar amount, skipping per-unit ones', () => {
    expect(dollars('$0.30 (text / image / video)<br>$1.00 (audio)')).toBe(0.3)
    expect(dollars('$0.039 per image*')).toBeNull()
    expect(dollars('$12.00 (text) $120.00 (images) $0.134 per 1K image')).toBe(
      12,
    )
    expect(dollars('$0.03 (text)<br>$1.00 / 1,000,000 tokens per hour')).toBe(
      0.03,
    )
    expect(dollars('Not available')).toBeNull()
  })

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

describe('anthropic pricing docs', () => {
  const md = `
| Model | Base Input Tokens | 5m Cache Writes | 1h Cache Writes | Cache Hits & Refreshes | Output Tokens |
| --- | --- | --- | --- | --- | --- |
| Claude Fable 5.1 | $10 / MTok | $12.50 / MTok | $20 / MTok | $0.25 / MTok1 | $50 / MTok |
| Claude Opus 4.1 ([retired](https://x)) | $15 / MTok | $18.75 / MTok | $30 / MTok | $1.50 / MTok | $75 / MTok |

### Batch
| Model | Batch Input | Batch Output |
| --- | --- | --- |
| Claude Fable 5.1 | $5 / MTok | $25 / MTok |
`
  it('keys USD/token pricing by display name, first table wins', () => {
    const parsed = parseAnthropicPricing(md)
    expect(parsed.get('Claude Fable 5.1')).toEqual({
      prompt: '0.00001',
      input_cache_write: '0.0000125',
      input_cache_read: '0.00000025',
      completion: '0.00005',
    })
    expect(parsed.get('Claude Opus 4.1')?.prompt).toBe('0.000015')
    expect(parsed.size).toBe(2)
  })

  it('derives request features from the capability tree + docs rules', () => {
    const tree = {
      thinking: { supported: true },
      effort: { supported: true },
      structured_outputs: { supported: true },
    }
    expect(
      anthropicCapabilities({ id: 'claude-fable-5-1', capabilities: tree }),
    ).toEqual([
      'tools',
      'tool_choice',
      'reasoning',
      'reasoning_effort',
      'reasoning_mandatory',
      'structured_outputs',
      'response_format',
    ])
    expect(
      anthropicCapabilities({
        id: 'claude-haiku-4-5-20251001',
        capabilities: { thinking: { supported: true } },
      }),
    ).toEqual([
      'tools',
      'tool_choice',
      'reasoning',
      'temperature',
      'top_p',
      'top_k',
    ])
  })
})

describe('gemini pricing docs', () => {
  const html = `
<h2 id="gemini-2.5-flash-image">Nano Banana</h2>
<em><a href="/x"><code translate="no">gemini-2.5-flash-image</code></a></em>
<table class="pricing-table"><tbody>
<tr><td>Input price</td><td>Free of charge</td><td>$0.30 (text / image)</td></tr>
<tr><td>Output price</td><td>Free of charge</td><td>$0.039 per image*</td></tr>
</tbody></table>
<h2 id="veo-3.1">Veo 3.1</h2>
<code translate="no">veo-3.1-generate-preview</code> <code>veo-3.1-fast-generate-preview</code>
<table class="pricing-table"><tbody>
<tr><td>Video with audio price</td><td>Not available</td><td>$0.40 / sec</td></tr>
</tbody></table>
<h2 id="gemini-2.5-flash">Gemini 2.5 Flash</h2>
<code translate="no" dir="ltr">gemini-2.5-flash</code>
<table class="pricing-table"><tbody>
<tr><td>Input price</td><td>Free of charge</td><td>$0.30 (text / image / video)<br>$1.00 (audio)</td></tr>
<tr><td>Output price (including thinking tokens)</td><td>Free of charge</td><td>$2.50</td></tr>
<tr><td>Context caching price</td><td>Not available</td><td>$0.03 (text)<br>$1.00 / 1,000,000 tokens per hour</td></tr>
</tbody></table>
<table class="pricing-table"><tbody><tr><td>Input price</td><td>Not available</td><td>$0.15</td></tr></tbody></table>
<h2 id="notes">Notes</h2>
`
  it('keys the standard-tier table by the codes under each heading', () => {
    const parsed = parseGeminiPricing(html)
    expect(parsed.get('gemini-2.5-flash')).toEqual({
      prompt: '0.0000003',
      completion: '0.0000025',
      input_cache_read: '0.00000003',
    })
    expect(parsed.get('gemini-2.5-flash-image')).toEqual({
      prompt: '0.0000003',
    })
    expect(parsed.has('veo-3.1-generate-preview')).toBe(false)
    expect(parsed.has('notes')).toBe(false)
  })

  it('derives modalities and features by activity + list row', () => {
    expect(geminiModalities('gemini-2.5-flash', 'chat')?.input).toContain(
      'file',
    )
    expect(geminiModalities('imagen-4.0-generate-001', 'image')).toEqual({
      input: ['text'],
      output: ['image'],
    })
    expect(
      geminiCapabilities(
        { thinking: true, temperature: 1, topP: 0.95 },
        'chat',
      ),
    ).toEqual([
      'tools',
      'tool_choice',
      'reasoning',
      'temperature',
      'top_p',
      'structured_outputs',
      'response_format',
    ])
    expect(geminiCapabilities({}, 'embeddings')).toBeNull()
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

  it('flags reasoning unless the id says non-reasoning; media models null', () => {
    expect(grokCapabilities('grok-4.6')).toContain('reasoning')
    expect(grokCapabilities('grok-4.20-0309-non-reasoning')).not.toContain(
      'reasoning',
    )
    expect(grokCapabilities('grok-imagine-image')).toBeNull()
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

## Pricing

### Text tokens

| Metric | Price | Unit |
| --- | ---: | --- |
| Input | $1.25 | 1M tokens |
| Cached input | $0.125 | 1M tokens |
| Output | $10 | 1M tokens |

### Text tokens

| Input | $0.625 | 1M tokens |

## Supported features

- streaming
- structured_outputs
- function_calling

## Snapshots

- \`gpt-5-2025-08-07\`
- \`gpt-5-2025-09-01\`

## Rate limits
`
  it('parses details, first pricing table, features, snapshots', () => {
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
      pricing: {
        prompt: '0.00000125',
        completion: '0.00001',
        input_cache_read: '0.000000125',
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

  it('resolves listed ids to index slugs, dated snapshots via the alias', () => {
    const slugs = parseModelIndex(
      '- [GPT-5](/api/docs/models/gpt-5.md): x\n- [Whisper](/api/docs/models/whisper-1.md): y',
    )
    expect(pageSlugFor('gpt-5-2025-08-07', slugs)).toBe('gpt-5')
    expect(pageSlugFor('whisper-1', slugs)).toBe('whisper-1')
    expect(pageSlugFor('gpt-5-search-api', slugs)).toBeNull()
  })
})
