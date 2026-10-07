import { describe, expect, it } from 'vitest'

import { cachedDocs } from './model-facts.ts'
import {
  TOGETHER_GLM_53_URL,
  TOGETHER_GPT_OSS_URL,
  TOGETHER_KIMI_K3_URL,
  TOGETHER_REASONING_URL,
  loadTogetherQuickstart,
  loadTogetherReasoningPage,
  loadTogetherServerlessChat,
  parseTogetherChatCatalog,
  parseTogetherQuickstartReasoning,
  parseTogetherReasoning,
  parseTogetherVisionModalities,
} from './together-facts.ts'

/** Excerpt of https://docs.together.ai/docs/serverless/models.md (2026-10-07). */
const MODELS_MD = `
## Chat models

| Organization | Model name | API model string | Context length | Input pricing (per 1M tokens) | Cached input pricing (per 1M tokens) | Output pricing (per 1M tokens) | Quantization | Function calling | Structured outputs |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| Thinking Machines | Inkling | thinkingmachines/Inkling | 524288 | \\$1.00 | \\$0.17 | \\$4.05 | NVFP4 | Yes | Yes |
| Qwen | Qwen3.8-2.4T-A95B | Qwen/Qwen3.8-2.4T-A95B | - | \\$2.00 | \\$0.50 | \\$6.00 | FP4 | - | - |
| Qwen | Qwen3.6 Plus | Qwen/Qwen3.6-Plus | 1000000 | \\$0.50 | - | \\$3.00 | - | - | - |
| Prism ML | Ternary Bonsai 27B | Prism-ML/Ternary-Bonsai-27B | 262144 | Free | - | Free | - | - | - |
| Together AI | Tev1 4B Experimental | together/Tev1-4B-experimental | 32768 | \\$0.042 | - | Free | - | - | - |

## Vision models

| Organization | Model name | API model string | Context length | Input pricing (per 1M tokens) | Output pricing (per 1M tokens) |
| :- | :- | :- | :- | :- | :- |
| Qwen | Qwen3.5 9B | Qwen/Qwen3.5-9B | 262144 | \\$0.17 | \\$0.25 |
| Minimax | Minimax M3 | MiniMaxAI/MiniMax-M3 | 524288 | \\$0.30 | \\$1.20 |
| Moonshot | Kimi K3 | moonshotai/Kimi-K3 | 1048576 | \\$3.00 | \\$15.00 |
`

/**
 * Excerpt of https://docs.together.ai/docs/inference/chat/reasoning.md
 * (2026-10-07). The DeepSeek R1 row is added: the live table has no
 * reasoning-only line, and a row of that type must not become an object.
 */
const REASONING_MD = `
Reasoning models fall into a few behavioral types:

* **Reasoning only:** Always produces reasoning tokens. Cannot be toggled off.
* **Hybrid:** Supports both reasoning and non-reasoning modes via \`reasoning={"enabled": True/False}\`.
* **Adjustable effort:** Supports the \`reasoning_effort\` parameter to control reasoning depth (\`"low"\`, \`"medium"\`, or \`"high"\`).

## Supported models

| Model | API string | Type | Context length |
| :- | :- | :- | :- |
| MiniMax M3 | \`MiniMaxAI/MiniMax-M3\` | Hybrid (on by default) | 512K |
| DeepSeek V4 Pro 0813 | \`deepseek-ai/DeepSeek-V4-Pro-0813\` | Hybrid (on by default) | 1M |
| GLM-5.2 | \`zai-org/GLM-5.2\` | Hybrid (on by default) | 512K |
| Kimi K3 | \`moonshotai/Kimi-K3\` | Hybrid (on by default) | 1M |
| Qwen3.6 Plus | \`Qwen/Qwen3.6-Plus\` | Hybrid (on by default) | 1M |
| Qwen3.5 9B | \`Qwen/Qwen3.5-9B\` | Hybrid (on by default) | 262K |
| GPT-OSS 120B | \`openai/gpt-oss-120b\` | Adjustable effort | 128K |
| DeepSeek R1 | \`deepseek-ai/DeepSeek-R1\` | Reasoning only | 128K |

## Reasoning effort

GPT-OSS models support a \`reasoning_effort\` parameter that controls how much computation the model spends on reasoning.

DeepSeek V4 Pro 0813 accepts only \`"high"\` and \`"max"\` for \`reasoning_effort\`. Other values are mapped automatically:

* \`"low"\` and \`"medium"\` map to \`"high"\`.
* \`"high"\` and \`"xhigh"\` map to \`"max"\`.
`

/** Excerpt of https://docs.together.ai/docs/kimi-k3-quickstart.md (2026-10-07). */
const KIMI_MD = `
The model ID is \`moonshotai/Kimi-K3\`.

## Set the thinking effort

K3 thinks by default at \`reasoning_effort="max"\`. Lower the level to cut cost and latency:

* \`"low"\`: shallow reasoning.
* \`"high"\`: deep reasoning.
* \`"max"\`: maximum reasoning, the default.

To skip thinking entirely on trivial turns, pass \`reasoning={"enabled": False}\`.

## Sampling parameters

| Parameter | Behavior on Together |
| - | - |
| \`reasoning_effort\` | \`"low"\`, \`"medium"\`, \`"high"\`, or \`"max"\` (default). Invalid strings are accepted silently, so validate client-side. |
| \`reasoning\` | \`{"enabled": False}\` disables thinking entirely. |
`

/** Excerpt of https://docs.together.ai/docs/glm-5.3-quickstart.md (2026-10-07). */
const GLM_MD = `
| Model | Model ID | Input / 1M tokens | Cached input / 1M tokens | Output / 1M tokens |
| - | - | - | - | - |
| GLM-5.3 | \`zai-org/GLM-5.3\` | \\$1.40 | \\$0.26 | \\$4.40 |
| GLM-5.3 Flash | \`zai-org/GLM-5.3-Flash\` | \\$0.15 | \\$0.03 | \\$0.50 |

The examples below use \`zai-org/GLM-5.3\`. Swap in \`zai-org/GLM-5.3-Flash\` when cost and latency matter more than maximum depth.

## Set the reasoning effort

\`reasoning_effort\` accepts \`"low"\`, \`"medium"\`, \`"high"\`, and \`"max"\`.

Thinking cannot be disabled entirely on GLM-5.3.

\`\`\`python
completion = client.chat.completions.create(
    model="zai-org/GLM-5.3",
    reasoning_effort="max",
)
\`\`\`
`

/** Excerpt of https://docs.together.ai/docs/gpt-oss.md (2026-10-07). */
const GPT_MD = `
The model ID is \`openai/gpt-oss-120b\`.

The smaller \`openai/gpt-oss-20b\` was removed from serverless inference.

## Set the reasoning effort

\`reasoning_effort\` accepts \`"low"\`, \`"medium"\`, and \`"high"\`. The default is \`"medium"\`.

Reasoning cannot be disabled entirely.
`

describe('together chat catalog', () => {
  it('reads context and standard per-million rates', () => {
    const rows = parseTogetherChatCatalog(MODELS_MD)
    expect(rows.get('thinkingmachines/Inkling')).toEqual({
      contextWindow: 524288,
      inputPerMillion: 1,
      cachedPerMillion: 0.17,
      outputPerMillion: 4.05,
    })
    expect(rows.get('Qwen/Qwen3.8-2.4T-A95B')?.contextWindow).toBeNull()
    expect(rows.get('Qwen/Qwen3.6-Plus')).toMatchObject({
      contextWindow: 1000000,
      cachedPerMillion: null,
    })
    expect(rows.get('Prism-ML/Ternary-Bonsai-27B')).toMatchObject({
      inputPerMillion: null,
      outputPerMillion: null,
    })
    expect(rows.get('together/Tev1-4B-experimental')).toMatchObject({
      inputPerMillion: 0.042,
      outputPerMillion: null,
    })
  })

  it('reads the vision table as text and image in, text out', () => {
    const vision = parseTogetherVisionModalities(MODELS_MD)
    expect(vision.get('Qwen/Qwen3.5-9B')).toEqual({
      input: ['text', 'image'],
      output: ['text'],
    })
    expect(vision.size).toBe(3)
  })
})

describe('together reasoning guide', () => {
  it('stores a toggle or the effort list the page names', () => {
    const rows = parseTogetherReasoning(REASONING_MD)
    expect(rows.get('MiniMaxAI/MiniMax-M3')).toEqual({
      mode: 'toggle',
      mandatory: false,
    })
    expect(rows.get('zai-org/GLM-5.2')).toEqual({
      mode: 'toggle',
      mandatory: false,
    })
    expect(rows.get('deepseek-ai/DeepSeek-V4-Pro-0813')).toEqual({
      mode: 'effort',
      mandatory: false,
      efforts: ['high', 'max'],
    })
    expect(rows.get('openai/gpt-oss-120b')).toEqual({
      mode: 'effort',
      mandatory: null,
      efforts: ['low', 'medium', 'high'],
    })
    expect(rows.has('deepseek-ai/DeepSeek-R1')).toBe(false)
  })
})

describe('together reasoning quickstarts', () => {
  it('reads Kimi K3 levels from the parameter table, including medium', () => {
    expect(
      parseTogetherQuickstartReasoning(KIMI_MD).get('moonshotai/Kimi-K3'),
    ).toEqual({
      mode: 'effort',
      mandatory: false,
      efforts: ['low', 'medium', 'high', 'max'],
    })
  })

  it('does not copy GLM-5.3 efforts onto GLM-5.3 Flash', () => {
    const rows = parseTogetherQuickstartReasoning(GLM_MD)
    expect(rows.get('zai-org/GLM-5.3')).toEqual({
      mode: 'effort',
      mandatory: true,
      efforts: ['low', 'medium', 'high', 'max'],
    })
    expect(rows.has('zai-org/GLM-5.3-Flash')).toBe(false)
  })

  it('reads GPT-OSS as mandatory effort and ignores the removed 20B id', () => {
    const rows = parseTogetherQuickstartReasoning(GPT_MD)
    expect([...rows.keys()]).toEqual(['openai/gpt-oss-120b'])
    expect(rows.get('openai/gpt-oss-120b')).toEqual({
      mode: 'effort',
      mandatory: true,
      efforts: ['low', 'medium', 'high'],
    })
  })
})

describe('together docs loaders', () => {
  it('throws when a page parses no rows', async () => {
    const original = globalThis.fetch
    globalThis.fetch = () =>
      Promise.resolve(new Response('# empty\n', { status: 200 }))
    try {
      await expect(
        loadTogetherReasoningPage(undefined, cachedDocs),
      ).rejects.toThrow(/together reasoning guide: parsed 0/)
      await expect(
        loadTogetherServerlessChat(undefined, cachedDocs),
      ).rejects.toThrow(/together serverless chat catalog: parsed 0/)
      await expect(
        loadTogetherQuickstart(undefined, cachedDocs, TOGETHER_KIMI_K3_URL),
      ).rejects.toThrow(/parsed 0/)
    } finally {
      globalThis.fetch = original
    }
  })

  it('fetches the published page urls', () => {
    expect(TOGETHER_REASONING_URL).toBe(
      'https://docs.together.ai/docs/inference/chat/reasoning.md',
    )
    expect(TOGETHER_GLM_53_URL).toContain('glm-5.3-quickstart.md')
    expect(TOGETHER_GPT_OSS_URL).toBe(
      'https://docs.together.ai/docs/gpt-oss.md',
    )
  })
})
