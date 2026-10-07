import { describe, expect, it } from 'vitest'

import {
  cerebrasRequestMap,
  cerebrasThinking,
  parseCerebrasChatSpec,
  parseCerebrasReasoning,
} from './cerebras-reasoning.ts'

/** Rows from https://inference-docs.cerebras.ai/capabilities/reasoning.md */
const REASONING = `
| Model | Default | \`reasoning_effort\` | Disable reasoning | Availability |
| - | - | - | - | - |
| [\`qwen-3.8-27b\`](/models/qwen-3.8-27b) | \`high\` | \`none\`, \`low\`, \`medium\`, \`high\` | Set \`reasoning_effort\` to \`none\` | Shared Inference |
| \`kimi-k2.7-code\` | Always enabled | Accepted but ignored | Not supported | Customer trials only |
| [\`gpt-oss-120b\`](/models/openai-oss) | \`medium\` | \`low\`, \`medium\`, \`high\` | Not supported | Shared Inference |
| [\`gemma-4-31b\`](/dedicated/overview#supported-models) | Disabled | \`none\`, \`low\`, \`medium\`, \`high\` | Set \`reasoning_effort\` to \`none\` | Dedicated Inference |

| Model | Default response behavior | \`raw\` | \`hidden\` |
| - | - | - | - |
| \`qwen-3.8-27b\` | Reasoning returned separately | Does not change the separated response format | Not supported |
`

/** The chat-spec sentences the request map is allowed to trust. */
const SPEC = `
        max_completion_tokens:
          type: integer
          nullable: true
          description: >
            The maximum number of tokens that can be generated in the
            completion, including reasoning tokens.
        max_tokens:
          type: integer
          nullable: true
          description: >
            An alias for \`max_completion_tokens\`. Do not send both parameters
            in the same request.
      description: >
        A message in the conversation. Developer messages are supported only by \`gpt-oss-120b\`.
`

describe('cerebras reasoning table', () => {
  const parsed = parseCerebrasReasoning(REASONING)

  it('reads effort lists and whether reasoning can be disabled', () => {
    expect(parsed.configured.get('qwen-3.8-27b')).toEqual({
      mode: 'effort',
      mandatory: false,
      efforts: ['none', 'low', 'medium', 'high'],
    })
    expect(parsed.configured.get('gpt-oss-120b')).toEqual({
      mode: 'effort',
      mandatory: true,
      efforts: ['low', 'medium', 'high'],
    })
    expect(parsed.configured.get('gemma-4-31b')?.mandatory).toBe(false)
    expect(parsed.ignored).toEqual(['kimi-k2.7-code'])
  })

  it('throws when a disable cell is neither none nor not supported', () => {
    expect(() =>
      parseCerebrasReasoning(`
| Model | Default | \`reasoning_effort\` | Disable reasoning | Availability |
| - | - | - | - | - |
| \`gpt-oss-120b\` | \`medium\` | \`low\`, \`high\` | Sometimes | Shared Inference |
`),
    ).toThrow(/unread disable cell/)
  })
})

describe('cerebras chat spec', () => {
  const spec = parseCerebrasChatSpec(SPEC)

  it('keeps max_completion_tokens and the developer-role ids', () => {
    expect(spec).toEqual({
      maxTokensField: 'max_completion_tokens',
      developerIds: ['gpt-oss-120b'],
    })
  })

  it('throws when max_tokens stops being the alias', () => {
    expect(() =>
      parseCerebrasChatSpec(SPEC.replace('An alias for', 'Previously')),
    ).toThrow(/not an alias/)
  })

  it('maps qwen off to none and leaves gpt-oss with no off body', () => {
    const reasoning = parseCerebrasReasoning(REASONING)
    expect(cerebrasThinking(['none', 'low', 'medium', 'high'])).toEqual({
      on: { reasoning_effort: 'high' },
      off: { reasoning_effort: 'none' },
      levels: {
        off: 'none',
        minimal: null,
        low: 'low',
        medium: 'medium',
        high: 'high',
        xhigh: null,
        max: null,
      },
    })
    const qwen = cerebrasRequestMap(
      'qwen-3.8-27b',
      spec,
      reasoning.configured.get('qwen-3.8-27b'),
      false,
    )
    const oss = cerebrasRequestMap(
      'gpt-oss-120b',
      spec,
      reasoning.configured.get('gpt-oss-120b'),
      false,
    )
    expect(qwen.developerRole).toBe(false)
    expect(qwen.thinking?.off).toEqual({ reasoning_effort: 'none' })
    expect(qwen.reasoningEffort).toBe(true)
    expect(oss.developerRole).toBe(true)
    expect(oss.thinking?.off).toBeNull()
    expect(oss.maxTokensField).toBe('max_completion_tokens')
    expect(oss.replayReasoningContent).toBeNull()
    expect(oss.toolStream).toBeNull()
  })
})
