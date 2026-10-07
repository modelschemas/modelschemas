import { describe, expect, it } from 'vitest'

import {
  anthropicReasoning,
  anthropicServerTools,
  parseThinkingTable,
} from './anthropic-features.ts'
import {
  familyOf,
  geminiModelFeatures,
  parsePageModalities,
  parsePageTools,
  parseThinkingPage,
} from './gemini-features.ts'
import { grokReasoningGap, parseGrokReasoning } from './grok.ts'

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

  it('does not invent a mode when the thinking tables omit the id', () => {
    const parsed = parseThinkingPage(thinking)
    expect(
      familyOf('gemini-2.5-computer-use-preview-10-2025', parsed.keys()),
    ).toBeNull()
    expect(familyOf('deep-research-preview-04-2026', parsed.keys())).toBeNull()
  })

  it('reads the Supported data types row, or nothing', () => {
    const row = (cells: string) => `x\n| Supported data types | ${cells} |\n`
    expect(
      parsePageModalities(
        row('**Inputs** Audio, images, video, text, and PDF **Output** Text'),
      ),
    ).toEqual({
      input: ['text', 'image', 'audio', 'video', 'file'],
      output: ['text'],
    })
    expect(
      parsePageModalities(
        row(
          '**Inputs** Audio (speech) **Output** Audio (translated speech) and Text (transcript)',
        ),
      ),
    ).toEqual({ input: ['audio'], output: ['text', 'audio'] })
    // A word that is not a medium leaves the whole fact unknown.
    expect(
      parsePageModalities(row('**Input** Text **Output** Text embeddings')),
    ).toBeNull()
    expect(
      parsePageModalities(
        row('**Input** Text, Image **Output** Video with audio'),
      ),
    ).toBeNull()
    expect(parsePageModalities('| Capabilities | x |')).toBeNull()
    // A parenthetical is dropped as a qualifier unless it names a medium.
    expect(
      parsePageModalities(
        row(
          '**Input** Text, Image, Video (up to 10s for editing) **Output** Audio (MP3), Text (Lyrics)',
        ),
      ),
    ).toEqual({ input: ['text', 'image', 'video'], output: ['text', 'audio'] })
    expect(
      parsePageModalities(
        row('**Inputs** Text (and Image, Audio) **Output** Text'),
      ),
    ).toBeNull()
    expect(
      parsePageModalities(row('**Inputs** Text **Output** Text (or images)')),
    ).toBeNull()
    expect(
      parsePageModalities(
        row('**Inputs** Text (short videos) **Output** Text'),
      ),
    ).toBeNull()
  })

  describe('model pages', () => {
    const INDEX = 'https://ai.google.dev/gemini-api/docs/models'
    const page = (types: string) =>
      `| Supported data types | ${types} |\n| Capabilities | **[Search grounding](u)** Supported |\n`
    const withPages = async <T>(
      pages: Record<string, string | null>,
      run: () => Promise<T>,
    ): Promise<T> => {
      const original = globalThis.fetch
      globalThis.fetch = ((url: string) => {
        const href = String(url)
        const slug = href.match(/\/models\/([^/]+)\.md\.txt$/)?.[1]
        const body = href.endsWith('/thinking.md.txt')
          ? thinking
          : slug
            ? pages[slug]
            : Object.keys(pages)
                .map((name) => `${INDEX}/${name}`)
                .join('\n')
        return Promise.resolve(
          typeof body === 'string'
            ? new Response(body)
            : new Response('upstream down', { status: 503 }),
        )
      }) as typeof fetch
      try {
        return await run()
      } finally {
        globalThis.fetch = original
      }
    }

    it('keeps stored facts, and records the failure, when a page fails to load', async () => {
      const { features, docsFailures } = await withPages(
        {
          'gemini-2.5-flash': page('**Inputs** Text, images **Output** Text'),
          'gemini-2.5-flash-lite': null,
        },
        () =>
          geminiModelFeatures([
            'gemini-2.5-flash',
            'gemini-2.5-flash-lite',
            'gemma-4-31b-it',
          ]),
      )
      expect(features('gemini-2.5-flash', false)).toMatchObject({
        modalities: { input: ['text', 'image'], output: ['text'] },
        serverTools: ['googleSearch'],
        factSources: {
          modalities: {
            derivation: 'docs-derived',
            sourceUrl: `${INDEX}/gemini-2.5-flash.md.txt`,
            path: 'Supported data types',
          },
        },
      })
      expect(features('gemini-2.5-flash', false).absent).toBeUndefined()
      // The page that failed: the poll keeps what is stored, and the row is
      // not handed to the `gemini-2.5-flash` page that did load.
      expect(features('gemini-2.5-flash-lite', false)).toMatchObject({
        modalities: null,
        serverTools: null,
        absent: { modalities: 'unavailable', serverTools: 'unavailable' },
      })
      expect(docsFailures.failed).toBe(1)
      expect(docsFailures.first[0]?.source).toBe(
        `${INDEX}/gemini-2.5-flash-lite.md.txt`,
      )
      // No page at all is a plain unknown.
      expect(features('gemma-4-31b-it', false).absent).toBeUndefined()
    })

    it('refuses a poll in which no page that loaded states modalities', async () => {
      await expect(
        withPages(
          {
            'gemini-2.5-flash': '| Supported modalities | Text |',
            'gemini-2.5-pro': '| Supported modalities | Text |',
          },
          () => geminiModelFeatures(['gemini-2.5-flash', 'gemini-2.5-pro']),
        ),
      ).rejects.toThrow('gemini model pages: 0 of 2 state modalities')
    })
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

  it('leaves tools empty when the page marks none supported', () => {
    const row =
      '| Capabilities | **[Code execution](u)** Not supported **[Search grounding](u)** Not supported |'
    expect(parsePageTools(`x\n${row}\n`)).toEqual([])
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
    const yes = page('- **Reasoning:** Yes')
    expect(parseGrokReasoning(yes)).toBeNull()
    expect(grokReasoningGap(yes)).toBe('silent')
    const no = page('- **Reasoning:** No')
    expect(parseGrokReasoning(no)).toBeNull()
    expect(grokReasoningGap(no)).toBeNull()
  })
})
