import { describe, expect, it } from 'vitest'

import { replicateReadmeFacts } from './replicate-readme.ts'

/** GET /v1/models/openai/gpt-5.4/readme, specs section, 2026-10-08. */
const GPT_54 = `
- **Long context**: Up to 1,050,000 token context window

## Specs

| | |
|---|---|
| **Context window** | 1,050,000 tokens |
| **Max output tokens** | 128,000 |
| **Knowledge cutoff** | August 31, 2025 |
`

/** GET /v1/models/anthropic/claude-opus-4.7/readme, 2026-10-08. */
const OPUS = `Claude Opus 4.7 features a one million token context window, letting it process and reason across large amounts of information. It can output up to 128,000 tokens.`

/** GET /v1/models/qwen/qwen3-235b-a22b-instruct-2507/readme, 2026-10-08. */
const QWEN = `
- **Enhanced capabilities** in **256K long-context understanding**.
- Context Length: **262,144 natively**.
\`\`\`
python -m sglang.launch_server --context-length 262144
\`\`\`
**Note: consider reducing the context length to a shorter value, such as \`32,768\`.**
`

/** GET /v1/models/prunaai/qwen-3.5-35b-a3b-fast/readme, 2026-10-08. */
const QWEN_35 = `    Context length: 262,144 tokens natively, extensible up to 1,010,000 tokens`

/** GET /v1/models/ibm-granite/granite-4.2-8b/readme, 2026-10-08. Two windows. */
const GRANITE = `
| **Context Length** | Natively Supports 128K (Long-context extension to 512K) |
- **512K Context Window:** Supports long documents.
`

/** GET /v1/models/deepseek-ai/deepseek-v3.1/readme, 2026-10-08. An eval note, not the model. */
const DEEPSEEK = `Search agents use a commercial search API + webpage filter + 128K context window.`

/** GET /v1/models/google/gemini-2.5-flash/readme, 2026-10-08. The published sentence is approximate (`~`). */
const GEMINI_TILDE = `- **Long Context Handling**: Works with extremely long inputs (up to ~1 million token context window).`

/** GET /v1/models/anthropic/claude-fable-5/readme, 2026-10-08. */
const FABLE = `- \`max_tokens\` - maximum number of output tokens, up to 128,000. Adaptive thinking shares this budget.`

/** GET /v1/models/jeffgreen311/eve-v2-unleashed/readme, 2026-10-08. */
const EVE = `
| Context Window | 16,384 tokens |
| Max Output | 8,192 tokens |
- 262K context window capability
| num_ctx | 16384 | Balanced context window |
`

/** Listing description of moonshotai/kimi-k2.6, 2026-10-08, beside its README sentence. */
const KIMI_README = `It has 1 trillion total parameters and a 262,144 token context window.`
const KIMI_DESCRIPTION =
  'Moonshot AI frontier model. 1 trillion parameters, 262k context window, vision and tool use.'

describe('replicate README facts', () => {
  it('reads a specs table and the same count restated in prose', () => {
    expect(replicateReadmeFacts(GPT_54)).toMatchObject({
      contextWindow: 1_050_000,
      maxOutput: 128_000,
      context: { from: 'readme', path: 'context window' },
      max: { path: 'max output tokens' },
    })
  })

  it('reads "one million token context window"', () => {
    expect(replicateReadmeFacts(OPUS).contextWindow).toBe(1_000_000)
    expect(replicateReadmeFacts(OPUS).maxOutput).toBeNull()
  })

  it('keeps the exact native window and ignores a rounded aside and a code sample', () => {
    expect(replicateReadmeFacts(QWEN)).toMatchObject({
      contextWindow: 262_144,
      context: { path: 'context length' },
    })
    expect(replicateReadmeFacts(QWEN_35).contextWindow).toBe(262_144)
  })

  it('states nothing when the README names two windows, an eval note, or an approximation', () => {
    expect(replicateReadmeFacts(GRANITE).contextWindow).toBeNull()
    expect(replicateReadmeFacts(DEEPSEEK).contextWindow).toBeNull()
    expect(replicateReadmeFacts(GEMINI_TILDE).contextWindow).toBeNull()
  })

  it('reads an output cap from a max_tokens bullet and a spec table', () => {
    expect(replicateReadmeFacts(FABLE)).toMatchObject({
      contextWindow: null,
      maxOutput: 128_000,
      max: { path: 'max_tokens' },
    })
    expect(replicateReadmeFacts(EVE)).toMatchObject({
      contextWindow: 16_384,
      maxOutput: 8_192,
    })
  })

  it('prefers the exact README count over the description abbreviation', () => {
    const facts = replicateReadmeFacts(KIMI_README, KIMI_DESCRIPTION)
    expect(facts.contextWindow).toBe(262_144)
    expect(facts.context?.from).toBe('readme')
  })

  it('reads a description abbreviation when the README states no window', () => {
    const facts = replicateReadmeFacts('', KIMI_DESCRIPTION)
    expect(facts.contextWindow).toBe(262_000)
    expect(facts.context).toEqual({ from: 'description', path: 'description' })
  })
})
