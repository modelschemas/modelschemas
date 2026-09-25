import { describe, expect, it } from 'vitest'

import {
  anthropicReasoning,
  anthropicServerTools,
  parseThinkingTable,
} from './anthropic-features.ts'
import {
  familyOf,
  parsePageTools,
  parseThinkingPage,
} from './gemini-features.ts'
import { parseGrokReasoning } from './grok.ts'

describe('anthropic features (issue #77)', () => {
  const table = `| Model                 | Thinking types                   | Default   | Rejected with 400          |
| --------------------- | -------------------------------- | --------- | -------------------------- |
| Claude Fable 5.1      | Adaptive only                    | Always on | \`"enabled"\`, \`"disabled"\`  |
| Claude Opus 5         | Adaptive only                    | On        | \`"enabled"\`, \`"disabled"\`2 |
| Claude Sonnet 4.5     | Extended only                    | Off       | \`"adaptive"\`               |`

  it('reads "Always on" as thinking that cannot be turned off', () => {
    expect([...parseThinkingTable(table)]).toEqual([
      ['claude fable 5.1', true],
      ['claude opus 5', false],
      ['claude sonnet 4.5', false],
    ])
  })

  it('prefers adaptive, falls back to budget, lists supported efforts', () => {
    const effort = {
      supported: true,
      low: { supported: true },
      max: { supported: false },
    }
    expect(
      anthropicReasoning(
        {
          thinking: {
            supported: true,
            types: {
              enabled: { supported: true },
              adaptive: { supported: true },
            },
          },
          effort,
        },
        true,
      ),
    ).toEqual({ mode: 'adaptive', mandatory: true, efforts: ['low'] })
    expect(
      anthropicReasoning(
        {
          thinking: {
            supported: true,
            types: {
              enabled: { supported: true },
              adaptive: { supported: false },
            },
          },
        },
        false,
      ),
    ).toEqual({ mode: 'budget', mandatory: false })
    expect(anthropicReasoning({ thinking: { supported: false } }, false)).toBe(
      null,
    )
  })

  it('gives every model the unrestricted tools, listed models the rest', () => {
    const opus = anthropicServerTools('claude-opus-5-5')
    expect(opus.serverTools).toContain('web_search_20250305')
    expect(opus.serverTools).toContain('computer_toolset_20260801')
    expect(opus.serverTools).not.toContain('computer_20251124')
    expect(opus.sources.web_search_20250305?.sourceUrl).toMatch(
      /web-search-tool$/,
    )
    const unknown = anthropicServerTools('claude-new-model')
    expect(unknown.serverTools).toContain('bash_20250124')
    expect(unknown.serverTools).not.toContain('code_execution_20250825')
  })
})

describe('gemini features (issue #77)', () => {
  const thinking = `| Thinking Level | Gemini 3.8 \\& 3.7 Flash | Gemini 3.1 Pro | Description |
|---|---|---|---|
| **\`minimal\`** | Not supported (error) | Not supported | x |
| **\`low\`** | Supported | Supported | x |
| **\`high\`** | Supported (Dynamic) | Supported (Default, Dynamic) | x |

| Model | Default setting (Thinking budget is not set) | Range | Disable thinking | Turn on dynamic thinking |
|---|---|---|---|---|
| **2.5 Pro** | Dynamic thinking | \`128\` to \`32768\` | N/A: Cannot disable thinking | \`thinkingBudget = -1\` (Default) |
| **2.5 Flash** | Dynamic thinking | \`0\` to \`24576\` | \`thinkingBudget = 0\` | \`thinkingBudget = -1\` (Default) |`

  it('keys levels by family column and budgets by family row', () => {
    const parsed = parseThinkingPage(thinking)
    expect(parsed.get('gemini-3.7-flash')).toEqual({
      mode: 'effort',
      mandatory: true,
      efforts: ['low', 'high'],
    })
    expect(parsed.get('gemini-3.1-pro')?.efforts).toEqual(['low', 'high'])
    expect(parsed.get('gemini-2.5-pro')).toEqual({
      mode: 'budget',
      mandatory: true,
    })
    expect(parsed.get('gemini-2.5-flash')).toEqual({
      mode: 'budget',
      mandatory: false,
    })
  })

  it('resolves ids to the longest family they version, never a sibling', () => {
    const families = ['gemini-2.5-flash', 'gemini-2.5-flash-lite']
    expect(familyOf('gemini-2.5-flash-lite-preview-09-2025', families)).toBe(
      'gemini-2.5-flash-lite',
    )
    expect(familyOf('gemini-2.5-flash-001', families)).toBe('gemini-2.5-flash')
    expect(familyOf('gemini-2.5-flash-image', families)).toBeNull()
  })

  it('maps Supported capabilities to generateContent tool fields', () => {
    const row =
      '| Capabilities | **[Code execution](u)** Supported **[Computer use](u)** Supported (Preview) **[File search](u)** Not supported **[Search grounding](u)** Supported **[Thinking](u)** Supported |'
    expect(parsePageTools(`x\n${row}\n`)).toEqual([
      'codeExecution',
      'computerUse',
      'googleSearch',
    ])
  })
})

describe('grok reasoning (issue #77)', () => {
  const page = (lines: string) =>
    `# Grok\n\n## Capabilities\n\n${lines}\n\n## Pricing\n`
  it('reads efforts; none means reasoning can be turned off', () => {
    expect(
      parseGrokReasoning(
        page(
          '- **Reasoning:** Yes\n- **Reasoning efforts (supported):** `low`, `high`',
        ),
      ),
    ).toEqual({ mode: 'effort', mandatory: true, efforts: ['low', 'high'] })
    expect(
      parseGrokReasoning(
        page(
          '- **Reasoning:** Yes\n- **Reasoning efforts (supported):** `none`, `low`',
        ),
      )?.mandatory,
    ).toBe(false)
  })

  it('stays null without a documented knob or without reasoning', () => {
    expect(parseGrokReasoning(page('- **Reasoning:** Yes'))).toBeNull()
    expect(parseGrokReasoning(page('- **Reasoning:** No'))).toBeNull()
  })
})
