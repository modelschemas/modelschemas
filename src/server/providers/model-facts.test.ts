import { describe, expect, it } from 'vitest'

import { anthropicCapabilities } from './anthropic.ts'
import { geminiCapabilities } from './gemini.ts'
import { parseGrokContextWindows } from './grok.ts'
import { markdownTableRows, tokenCount, undatedId } from './model-facts.ts'
import { openAiCompatModelFacts } from './openai-compat.ts'
import {
  pageSlugFor,
  parseModelIndex,
  parseModelPage,
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
