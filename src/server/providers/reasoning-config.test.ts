import { describe, expect, it } from 'vitest'

import { takeIngestEvents } from '../ingest/ingest-signals.ts'
import {
  keepValidReasoning,
  openRouterReasoning,
  parseByteplusReasoning,
  parseCohereReasoning,
  parseGroqReasoning,
  parseMistralReasoning,
} from './reasoning-config.ts'
import { reasoningViolation } from './types.ts'

describe('reasoningViolation', () => {
  it.each([
    { mode: 'effort', mandatory: true },
    { mode: 'effort', mandatory: null, efforts: ['low', 'max'] },
    { mode: 'effort', mandatory: false, efforts: ['none', 'low'] },
    { mode: 'adaptive', mandatory: false },
    // One prod budget row carries efforts; that is allowed.
    { mode: 'budget', mandatory: false, efforts: ['low'] },
    { mode: 'toggle', mandatory: false },
    { mode: 'toggle', mandatory: true },
  ])('accepts %j', (value) => {
    expect(reasoningViolation(value)).toBeNull()
  })

  it.each([
    ['a non-object', 'effort', 'not an object'],
    ['an unknown mode', { mode: 'switch', mandatory: false }, 'unknown mode'],
    ['a missing mandatory', { mode: 'effort' }, 'mandatory is not'],
    ['a string mandatory', { mode: 'effort', mandatory: 'no' }, 'mandatory'],
    [
      'a toggle with an unstated mandatory',
      { mode: 'toggle', mandatory: null },
      'a toggle needs a stated mandatory',
    ],
    [
      'efforts on a toggle',
      { mode: 'toggle', mandatory: false, efforts: ['low'] },
      'a toggle takes no efforts',
    ],
    [
      'empty efforts',
      { mode: 'effort', mandatory: true, efforts: [] },
      'efforts',
    ],
    [
      'a non-string effort',
      { mode: 'effort', mandatory: true, efforts: ['low', 1] },
      'efforts',
    ],
    [
      'null efforts',
      { mode: 'effort', mandatory: true, efforts: null },
      'efforts',
    ],
  ])('refuses %s', (_case, value, reason) => {
    expect(reasoningViolation(value)).toContain(reason)
  })
})

describe('keepValidReasoning', () => {
  const source = { derivation: 'listing' as const, sourceUrl: 'https://x.test' }

  it('passes a valid or absent object through untouched', () => {
    const valid = {
      rawId: 'm',
      reasoning: { mode: 'toggle', mandatory: false },
    }
    expect(keepValidReasoning('p', valid as never)).toBe(valid)
    const none = { rawId: 'm', reasoning: null }
    expect(keepValidReasoning('p', none)).toBe(none)
    expect(takeIngestEvents()).toEqual([])
  })

  it('keeps the prior value and source, and reports the refusal', () => {
    const prior = {
      reasoning: { mode: 'effort', mandatory: true },
      factSources: { reasoning: { ...source, path: 'old' } },
    }
    const kept = keepValidReasoning(
      'prov',
      {
        rawId: 'm-1',
        reasoning: { mode: 'toggle', mandatory: null },
        factSources: { reasoning: source, contextWindow: source },
      },
      prior,
    )
    expect(kept.reasoning).toEqual(prior.reasoning)
    expect(kept.factSources).toEqual({
      contextWindow: source,
      reasoning: prior.factSources.reasoning,
    })
    expect(takeIngestEvents()).toEqual([
      {
        event: 'ingest_failed',
        properties: {
          job: 'models-poll',
          providerId: 'prov',
          error: 'm-1: reasoning not stored: a toggle needs a stated mandatory',
        },
      },
    ])
  })

  it('stores nothing on a new row', () => {
    const kept = keepValidReasoning('prov', {
      rawId: 'm-2',
      reasoning: { mode: 'toggle', mandatory: null },
      factSources: { reasoning: source },
    })
    expect(kept.reasoning).toBeNull()
    expect(kept.factSources).toBeUndefined()
    takeIngestEvents()
  })
})

const MISTRAL = `
# Reasoning

- \`mistral-small-latest\`: Supports adjustable reasoning via the \`reasoning_effort\` parameter. No extra configuration required.
- \`mistral-medium-3-5\`: Supports adjustable reasoning via the \`reasoning_effort\` parameter.
- \`zai-glm-5-3\`: Supports adjustable reasoning via the \`reasoning_effort\` parameter. Supported values are \`low\`, \`high\`, and \`max\` (see note below).

- \`reasoning_effort = "high"\`: full thinking chunk.
- \`reasoning_effort = "none"\`: thinking chunk omitted.

\`zai-glm-5-3\` supports \`low\`, \`high\`, and \`max\` — not \`none\`.

## Handling thinking chunks
`

const NATIVE = `
# Native reasoning (deprecated)

Native reasoning models always generate thinking traces without any extra parameters:

- \`magistral-small-latest\`: open smaller version.
- \`magistral-medium-latest\`: more powerful reasoning model.
`

const GROQ = `
# Reasoning

## [Supported Models](#supported-models)

| Model ID | Model |
| --- | --- |
| openai/gpt-oss-120b | [OpenAI GPT-OSS 120B](https://example.com/120) |
| openai/gpt-oss-safeguard-20b | [OpenAI GPT-OSS-Safeguard 20B](https://example.com/safe) |
| qwen/qwen3.8-27b | [Qwen 3.8 27B](https://example.com/qwen) |
| minimaxai/minimax-m2.7 | [MiniMax M2.7](https://example.com/mini) |

### Options for Reasoning Effort (Qwen 3.8 27B)

[Qwen 3.8 27B](https://example.com/qwen) supports the following options:

| reasoning_effort Options | Description |
| --- | --- |
| none | Disable reasoning. |
| default | Default behavior. |
| low | Low effort. |
| medium | Medium effort. |
| high | High effort. |

### Options for Reasoning Effort (GPT-OSS)

This is only supported by [GPT-OSS 120B](https://example.com/120).

| reasoning_effort Options | Description |
| --- | --- |
| low | Low effort. |
| medium | Medium effort. |
| high | High effort. |
`

const COHERE = `
# Reasoning

\`\`\`python
response = co.chat(
    model="command-a-reasoning-08-2025",
    messages=[{"role": "user", "content": "Hi"}],
)
\`\`\`

thinking={
    "type": "disabled" # turns off thinking. It is set to "enabled" by default.
}

thinking = {"token_budget": 500}
`

const COHERE_SILENT = `
# Reasoning

model="command-r-08-2024"

Reasoning is on by default. No budget or effort parameter is documented.
`

const BYTEPLUS = `
## Adjust chain-of-thought length

* \`none\`: Turn off reasoning.
* \`minimal\`: Turns off reasoning and answers directly.
* \`low\`: Light reasoning.
* \`high\`: Deep analysis.

|Supported models |Default value |Compatibility mapping |
|---|---|---|
|\\* \`dola-seed-2-1-turbo-260628\` | | |
|* \`seed-2-0-lite-260228\`<br>* \`glm-5-2-260617\` |\`medium\` | If \`none\` is passed, reasoning is turned off. |

## Pass thinking content back

\`seed-1-6-250615\` supports thinking but is not in the effort table.
`

describe('openRouterReasoning', () => {
  it('copies published efforts and does not invent a mode', () => {
    expect(
      openRouterReasoning({
        reasoning: {
          supported_efforts: ['high', 'low', null],
          mandatory: false,
        },
      }),
    ).toEqual({
      mode: 'effort',
      mandatory: false,
      efforts: ['high', 'low'],
    })
    expect(
      openRouterReasoning({
        reasoning: { supported_efforts: null, mandatory: true },
      }),
    ).toEqual({ mode: 'effort', mandatory: true })
    expect(
      openRouterReasoning({
        reasoning: { supports_max_tokens: true, mandatory: true },
      }),
    ).toEqual({ mode: 'budget', mandatory: true })
    expect(
      openRouterReasoning({
        reasoning: { mandatory: true },
      }),
    ).toBeNull()
    expect(
      openRouterReasoning({
        reasoning: null,
      }),
    ).toBeNull()
  })
})

describe('parseMistralReasoning', () => {
  it('reads effort names the guide states, and leaves native models unset', () => {
    const parsed = parseMistralReasoning(MISTRAL)
    expect(parsed.get('mistral-small-latest')).toEqual({
      mode: 'effort',
      mandatory: false,
    })
    expect(parsed.get('mistral-medium-3-5')).toEqual({
      mode: 'effort',
      mandatory: false,
    })
    expect(parsed.get('mistral-medium-3-5')?.mode).toBe('effort')
    expect(parsed.get('zai-glm-5-3')).toEqual({
      mode: 'effort',
      mandatory: true,
      efforts: ['low', 'high', 'max'],
    })
    expect(parseMistralReasoning(NATIVE).get('magistral-medium-latest')).toBe(
      undefined,
    )
  })
})

describe('parseGroqReasoning', () => {
  it('reads each effort table and leaves models with no options unset', () => {
    const parsed = parseGroqReasoning(GROQ)
    expect(parsed.get('qwen/qwen3.8-27b')).toEqual({
      mode: 'effort',
      mandatory: false,
      efforts: ['none', 'default', 'low', 'medium', 'high'],
    })
    expect(parsed.get('openai/gpt-oss-120b')).toEqual({
      mode: 'effort',
      mandatory: true,
      efforts: ['low', 'medium', 'high'],
    })
    expect(parsed.get('openai/gpt-oss-safeguard-20b')).toBeUndefined()
    expect(parsed.get('minimaxai/minimax-m2.7')).toBeUndefined()
  })
})

describe('parseCohereReasoning', () => {
  it('uses token_budget as budget mode and stays null without that knob', () => {
    expect(
      parseCohereReasoning(COHERE).get('command-a-reasoning-08-2025'),
    ).toEqual({ mode: 'budget', mandatory: false })
    expect(
      parseCohereReasoning(COHERE_SILENT).get('command-r-08-2024'),
    ).toBeUndefined()
  })

  it('covers every reasoning model only while the guide calls them hybrid', () => {
    // The sentence as https://docs.cohere.com/docs/reasoning.md had it on
    // 2026-10-07.
    const hybrid = `Cohere's reasoning models are *hybrid*, meaning reasoning can be enabled (in which case they generate internal reasoning processes before delivering their final responses) or disabled (in which case they function the way any other LLM would).`
    expect(parseCohereReasoning(COHERE).has('*')).toBe(false)
    expect(parseCohereReasoning(`${hybrid}\n${COHERE}`).get('*')).toEqual({
      mode: 'budget',
      mandatory: false,
    })
    expect(
      parseCohereReasoning(
        `${hybrid.replace('or disabled', 'but not disabled')}\n${COHERE}`,
      ).has('*'),
    ).toBe(false)
    // Without the budget knob the sentence configures nothing.
    expect(parseCohereReasoning(`${hybrid}\n${COHERE_SILENT}`).size).toBe(0)
  })
})

describe('parseByteplusReasoning', () => {
  it('copies the published effort list onto supported-model ids only', () => {
    const parsed = parseByteplusReasoning(BYTEPLUS)
    expect(parsed.get('seed-2-0-lite-260228')).toEqual({
      mode: 'effort',
      mandatory: false,
      efforts: ['none', 'minimal', 'low', 'high'],
    })
    expect(parsed.get('dola-seed-2-1-turbo-260628')?.mode).toBe('effort')
    expect(parsed.get('glm-5-2-260617')?.efforts).toEqual([
      'none',
      'minimal',
      'low',
      'high',
    ])
    expect(parsed.get('seed-1-6-250615')).toBeUndefined()
  })
})
