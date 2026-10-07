import { describe, expect, it } from 'vitest'

import {
  AZURE_MODELS_URL,
  AZURE_REASONING_URL,
  azureChatMaxTokensField,
  azureContextWindow,
  azureModelInfo,
  parseAzureEffortRules,
  parseAzureFeatureMatrix,
  parseAzureModels,
} from './azure-models.ts'
import type { AzureFeatureColumn, AzureModelRow } from './azure-models.ts'

/** Excerpt of the models article's markdown twin (2026-10-06). CRLF kept. */
const MODELS_PAGE = [
  '# Foundry Models sold by Azure',
  '',
  '::: zone pivot="azure-openai"',
  '',
  '### Model highlights',
  '',
  '| Models | Description |',
  '| --- | --- |',
  '| [GPT-5.4 series](models-sold-directly-by-azure#gpt-54) | `gpt-5.4-mini`, `gpt-5.4-pro` |',
  '',
  '## GPT-5.4',
  '',
  '| Model ID | Description | Context Window | Max Output Tokens | Training Data (up to) |',
  '| --- | --- | --- | --- | --- |',
  '| `gpt-5.4-pro` (2026-03-05) | - [Reasoning](../../openai/how-to/reasoning) - [Responses API](../../openai/how-to/responses).  - Text and image processing.  - Functions & tools  - [Full summary of capabilities](../../openai/how-to/reasoning). | 1,050,000 Input: 922,000Output: 128,000 | 128,000 | August 2025 |',
  '| `gpt-5.4-mini` (2026-03-17) | - [Reasoning](../../openai/how-to/reasoning) - [Responses API](../../openai/how-to/responses). - Chat Completions API.  - Structured outputs. - Text and image processing.  - Functions, tools, and parallel tool calling. | 400,000 Input: 272,000  Output: 128,000 | 128,000 | August 2025 |',
  '',
  '## GPT-5.2',
  '',
  '| Model ID | Description | Context Window | Max Output Tokens | Training Data (up to) |',
  '| --- | --- | --- | --- | --- |',
  '| `gpt-5.2-codex` (2026-01-14) | - [Responses API](../../openai/how-to/responses).  - Structured outputs. - Text and image processing.  - Functions, tools, and parallel tool calling.  - [Full summary of capabilities](../../openai/how-to/reasoning). | 400,000Input: 272,000Output: 128,000 | 128,000 | August 2025 |',
  '| `gpt-5.2-chat` (2025-12-11)**Retired May 13, 2026** | Historical specifications.  - Chat Completions API.  - Structured outputs  - Functions, tools, and parallel tool calling. | 128,000 Input: 111,616  Output: 16,384 | 16,384 | August 2025 |',
  '| `gpt-5.2-chat` (2026-02-10)**Retired June 29, 2026** | Historical specifications.  - Chat Completions API.  - Structured outputs  - Functions, tools, and parallel tool calling. | 128,000 Input: 111,616  Output: 16,384 | 16,384 | August 2025 |',
  '',
  '## gpt-oss',
  '',
  '| Model ID | Description | Context Window | Max Output Tokens | Training Data (up to) |',
  '| --- | --- | --- | --- | --- |',
  '| `gpt-oss-120b`^1^ (Preview) | - Text in/text out only  - Chat Completions API  - Streaming  - Function calling  - Structured outputs  - Reasoning | 131,072 | 131,072 | May 31, 2024 |',
  '',
  '## GPT-4.1 series',
  '',
  '| Model ID | Description | Context window | Max output tokens | Training data (up to) |',
  '| --- | --- | --- | --- | --- |',
  '| `gpt-4.1` (2025-04-14) | - Text and image input  - Text output  - Chat completions API - Responses API  - Streaming  - Function calling  - Structured outputs (chat completions) | - 1,047,576  - 300,000 (standard deployments)  - 128,000 (provisioned managed and batch deployments) | 32,768 | May 31, 2024 |',
  '',
  '## GPT-5',
  '',
  '| Model ID | Description | Context Window | Max Output Tokens | Training Data (up to) |',
  '| --- | --- | --- | --- | --- |',
  '| `gpt-5-codex` (2025-09-11) | - [Responses API](../../openai/how-to/responses) only.  - **Input**: Text/Image  - **Output**: Text only  - Structured outputs. - Functions, tools, and parallel tool calling. | 400,000Input: 272,000Output: 128,000 | 128,000 | - |',
  '',
  'Keep the following in mind when you call the `gpt-5.6` models and set `max_output_tokens`.',
  '',
  '## O-Series models',
  '',
  '`o3-deep-research` is currently only available with Foundry Agent Service.',
  '',
  '| Model ID | Description | Max request (tokens) | Training data (up to) |',
  '| --- | --- | --- | --- |',
  '| `o3-mini` (2025-01-31) | - [Enhanced reasoning abilities](../../openai/how-to/reasoning).  - Structured outputs. - Text-only processing.  - Functions and tools. | Input: 200,000  Output: 100,000 | October 2023 |',
  '| `o1-mini`^2^ (2024-09-12) | A faster and more cost-efficient option in the o1 series. | Input: 128,000  Output: 65,536 | October 2023 |',
  '',
  '## GPT-4o and GPT-4 Turbo',
  '',
  '| Model ID | Description | Max request (tokens) | Training data (up to) |',
  '| --- | --- | --- | --- |',
  '| `gpt-4o` (2024-08-06)  GPT-4o (Omni) | - Structured outputs. - Text and image processing.  - JSON Mode.  - Parallel function calling. | Input: 128,000  Output: 16,384 | October 2023 |',
  '| `gpt-4o` (2024-11-20)  GPT-4o (Omni) | - Structured outputs. - Text and image processing.  - JSON Mode.  - Parallel function calling. | Input: 128,000  Output: 16,384 | October 2023 |',
  '',
  '## Embeddings',
  '',
  '| Model ID | Max request (tokens) | Output dimensions | Training data (up to) |',
  '| --- | --- | --- | --- |',
  '| `text-embedding-3-large` | 8,192 | 3,072 | Sep 2021 |',
  '',
  '## Image generation models',
  '',
  '| Model ID | Max request (characters) |',
  '| --- | --- |',
  '| `gpt-image-2` | 4,000 |',
  '',
  '## Audio models',
  '',
  '### GPT-4o audio models',
  '',
  '| Model ID | Description | Max request (tokens) | Training data (up to) |',
  '| --- | --- | --- | --- |',
  '| `gpt-audio`(2025-08-28)`gpt-audio-mini`(2025-10-06) | Audio model for audio and text generation. | Input: 128,000  Output: 16,384 | October 2023 |',
  '',
  '## Fine-tuning models',
  '',
  '| Model ID | Standard regions | Data Zone | Global | Developer | Methods | Status | Modality |',
  '| --- | --- | --- | --- | --- | --- | --- | --- |',
  '| `Ministral-3B` (2411) | Not supported | US | ✅ | ❌ | SFT | GA | Text to text |',
  '',
  '::: zone-end',
  '',
  '::: zone pivot="azure-direct-others"',
  '',
  '## DeepSeek models sold by Azure',
  '',
  '| Model ID | Description | Context Window | Max Output Tokens |',
  '| --- | --- | --- | --- |',
  '| `DeepSeek-V3.2` | Chat | 128,000 | 128,000 |',
  '',
  '::: zone-end',
].join('\r\n')

/** Excerpt of the reasoning article's feature matrices (2026-10-06). */
const REASONING_PAGE = `## API and feature support

# [GPT-6 reasoning models](#tab/gpt-6)
| **Feature** | **gpt-6-sol**,**2026-09-22** |
| --- | --- |
| **[Structured outputs](structured-outputs)** | ✅ |
| **Input modalities** | Text and images |
| **Output modalities** | Text |
| Chat Completions API | ✅ |
| Responses API | ✅ |
| Functions/tools | ✅ |
| **Reasoning effort** (including \`none\`) | ✅ |

# [GPT-5 reasoning models](#tab/gpt-5)
| **Feature** | **gpt-5.4-pro** | **gpt-5.2-codex**,**2026-01-14** | **gpt-5-codex**,**2025-09-011** |
| --- | --- | --- | --- |
| **[Structured Outputs](structured-outputs)** | ✅ | ✅ | ✅ |
| **Reasoning effort**^7^ | ✅ | ✅ | ✅ |
| **[Image input](gpt-with-vision)** | ✅ | ✅ | ✅ |
| Chat Completions API | - | - | - |
| Responses API | ✅ | ✅ | ✅ |
| Functions/Tools | ✅^9^ | ✅ | ✅ |

### GPT-5 and GPT-6 reasoning features

| Feature | Description |
| --- | --- |
| \`reasoning_effort\` | \`max\` works only with GPT-6 or GPT-5.6 models. |

# [O-Series Reasoning Models](#tab/o-series)
| **Feature** | **o3-mini**,**2025-01-31** |
| --- | --- |
| **Reasoning effort** | ✅ |
| **[Image input](gpt-with-vision)** | - |
| Chat Completions API | ✅ |
| Functions/Tools | ✅ |
`

const HASHES = { models: 'm', reasoning: 'r' }

describe('azure models article', () => {
  const rows = parseAzureModels(MODELS_PAGE)

  it('lists the Azure OpenAI pivot and skips tables that are not catalogs', () => {
    expect([...rows.keys()]).toEqual([
      'gpt-5.4-pro',
      'gpt-5.4-mini',
      'gpt-5.2-codex',
      'gpt-5.2-chat',
      'gpt-oss-120b',
      'gpt-4.1',
      'gpt-5-codex',
      'o3-mini',
      'o1-mini',
      'gpt-4o',
      'text-embedding-3-large',
      'gpt-image-2',
      'gpt-audio',
      'gpt-audio-mini',
      // Named only in running text; the adapter keeps the metered ones.
      'gpt-5.6',
      'o3-deep-research',
    ])
    expect(rows.get('o3-deep-research')).toMatchObject({
      tabulated: false,
      activity: null,
    })
    expect(rows.get('gpt-4.1')?.tabulated).toBe(true)
  })

  it('reads the standard-deployments limit from a per-deployment cell', () => {
    expect(
      azureContextWindow(
        '- 1,047,576  - 300,000 (standard deployments)  - 128,000 (provisioned managed and batch deployments)',
      ),
    ).toBe(300_000)
    expect(azureContextWindow('400,000Input: 272,000Output: 128,000')).toBe(
      400_000,
    )
    expect(azureContextWindow('1,050,000 Input: 922,000Output: 128,000')).toBe(
      1_050_000,
    )
    expect(azureContextWindow('131,072')).toBe(131_072)
    // Qualifiers this does not know, or limits with none, are not guessed at.
    expect(
      azureContextWindow('- 1,047,576  - 300,000 (regional deployments)'),
    ).toBeNull()
    expect(azureContextWindow('1,047,576 300,000')).toBeNull()
    expect(azureContextWindow('300,000 (batch deployments)')).toBeNull()
    expect(azureContextWindow('')).toBeNull()
  })

  it('reads activity from the section and the token columns', () => {
    expect(rows.get('gpt-5.4-mini')?.activity).toBe('chat')
    expect(rows.get('text-embedding-3-large')?.activity).toBe('embeddings')
    expect(rows.get('gpt-image-2')?.activity).toBe('image')
    expect(rows.get('gpt-audio-mini')?.activity).toBe('audio')
  })

  it('reads token limits from either column layout', () => {
    expect(rows.get('gpt-5.4-pro')).toMatchObject({
      contextWindow: 1_050_000,
      maxOutput: 128_000,
    })
    expect(rows.get('gpt-4.1')).toMatchObject({
      contextWindow: 300_000,
      maxOutput: 32_768,
    })
    expect(rows.get('o3-mini')).toMatchObject({
      contextWindow: 200_000,
      maxOutput: 100_000,
    })
    expect(rows.get('text-embedding-3-large')).toMatchObject({
      contextWindow: 8192,
      maxOutput: null,
    })
    expect(rows.get('gpt-image-2')?.contextWindow).toBeNull()
  })

  it('keeps the newest version and marks a model with only retired rows', () => {
    expect(rows.get('gpt-4o')).toMatchObject({
      version: '2024-11-20',
      retired: false,
    })
    expect(rows.get('gpt-5.2-chat')).toMatchObject({
      version: '2026-02-10',
      retired: true,
    })
  })

  it('states only what the description says', () => {
    expect(rows.get('gpt-oss-120b')).toMatchObject({
      modalities: { input: ['text'], output: ['text'] },
      capabilities: [
        'tools',
        'reasoning',
        'structured_outputs',
        'response_format',
      ],
      chatCompletions: true,
      responses: false,
    })
    // The link to the reasoning guide is not a reasoning claim.
    expect(rows.get('gpt-5.2-codex')?.capabilities).toEqual([
      'tools',
      'structured_outputs',
      'response_format',
    ])
    expect(rows.get('o1-mini')).toMatchObject({
      modalities: null,
      capabilities: [],
    })
  })

  it('parses nothing from a page without the pivot', () => {
    expect(parseAzureModels('| Model ID |\n| --- |\n| `gpt-5` |').size).toBe(0)
  })
})

describe('azure reasoning feature matrix', () => {
  const matrix = parseAzureFeatureMatrix(REASONING_PAGE)

  it('reads one column per model and ignores the prose table', () => {
    expect([...matrix.keys()]).toEqual([
      'gpt-6-sol',
      'gpt-5.4-pro',
      'gpt-5.2-codex',
      'gpt-5-codex',
      'o3-mini',
    ])
    expect(matrix.get('gpt-6-sol')).toEqual({
      capabilities: [
        'structured_outputs',
        'response_format',
        'tools',
        'reasoning',
      ],
      modalities: { input: ['text', 'image'], output: ['text'] },
      chatCompletions: true,
      responses: true,
      effort: true,
      effortIncludesNone: true,
      developerMessages: null,
      maxCompletionTokens: null,
    })
    expect(matrix.get('o3-mini')).toMatchObject({
      modalities: { input: ['text'], output: [] },
      chatCompletions: true,
      responses: null,
    })
  })
})

describe('azure catalog row', () => {
  const rows = parseAzureModels(MODELS_PAGE)
  const matrix = parseAzureFeatureMatrix(REASONING_PAGE)
  const info = (id: string) => {
    const row = rows.get(id)
    if (!row) throw new Error(`fixture has no ${id}`)
    return azureModelInfo(row, matrix.get(id), HASHES)
  }

  it('lets the matrix column add reasoning and pick the route', () => {
    const codex = info('gpt-5.2-codex')
    expect(codex.capabilities).toEqual([
      'structured_outputs',
      'response_format',
      'reasoning',
      'tools',
    ])
    expect(codex.schemaEndpointId).toBe('responses')
    expect(codex.reasoning).toBeUndefined()
    expect(codex.factSources?.capabilities?.reasoning).toMatchObject({
      derivation: 'docs-derived',
      sourceUrl: AZURE_REASONING_URL,
      sourceHash: 'r',
    })
    expect(codex.factSources?.contextWindow).toMatchObject({
      sourceUrl: AZURE_MODELS_URL,
      sourceHash: 'm',
    })
  })

  it('falls back to the description when the model has no column', () => {
    const model = info('gpt-4.1')
    expect(model).toMatchObject({
      activity: 'chat',
      modalities: { input: ['text', 'image'], output: ['text'] },
      schemaEndpointId: 'chat/completions',
      deprecated: false,
    })
    expect(model.factSources?.modalities?.sourceUrl).toBe(AZURE_MODELS_URL)
  })

  it('keeps an output the row states when the matrix has no output row', () => {
    const codex = info('gpt-5-codex')
    expect(codex.modalities).toEqual({
      input: ['text', 'image'],
      output: ['text'],
    })
    expect(codex.factSources?.modalities?.sourceUrl).toBe(AZURE_REASONING_URL)
  })

  it('marks a chat row silent when neither source states modalities', () => {
    expect(info('o1-mini').factSources?.modalities).toMatchObject({
      sourceUrl: AZURE_MODELS_URL,
      path: 'silent',
    })
    expect(info('gpt-5.2-chat').factSources?.modalities?.path).toBe('silent')
    expect(info('gpt-image-2').factSources?.modalities).toBeUndefined()
  })

  it('leaves unstated facts null', () => {
    expect(info('o1-mini')).toMatchObject({
      modalities: null,
      capabilities: null,
      schemaEndpointId: null,
    })
    // Neither API is named on the gpt-4o rows.
    expect(info('gpt-4o').schemaEndpointId).toBeNull()
    expect(info('gpt-5.2-chat').deprecated).toBe(true)
    expect(info('gpt-image-2')).toMatchObject({
      activity: 'image',
      capabilities: null,
      schemaEndpointId: null,
    })
  })
})

/** Clauses copied from the reasoning article's markdown twin (2026-10-08). */
const EFFORT_RULES = [
  "`max` works only with GPT-6 or GPT-5.6 models and the Responses API. `xhigh` works only with GPT-6, GPT-5.6, GPT-5.5, GPT-5.4, and `gpt-5.1-codex-max` models. `minimal` works only with the original GPT-5 reasoning models. `minimal` doesn't work with `gpt-5.1` or greater. **Options (model-dependent)**: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`",
  '^5^`gpt-5-pro` only supports `reasoning_effort``high`, this is the default value even when not explicitly passed to the model.',
  "^7^`gpt-5.6`, `gpt-5.5`, `gpt-5.4`, `gpt-5.2`, `gpt-5.1`, `gpt-5.1-codex`, `gpt-5.1-codex-max`, and `gpt-5.1-codex-mini` support `'None'` as a value for the `reasoning_effort` parameter.",
  '^\\*^`gpt-5-codex` also does not support `reasoning_effort``minimal`.',
].join('\n')

const COLUMN_IDS = new Set([
  'gpt-6-astra',
  'gpt-6-sol',
  'gpt-6-luna',
  'gpt-6.1-sol',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-nano',
  'gpt-5.4-mini',
  'gpt-5.4-pro',
  'gpt-5.3-codex',
  'gpt-5.2',
  'gpt-5.2-codex',
  'gpt-5.1',
  'gpt-5.1-codex',
  'gpt-5.1-codex-mini',
  'gpt-5.1-codex-max',
  'gpt-5',
  'gpt-5-mini',
  'gpt-5-nano',
  'gpt-5-pro',
  'gpt-5-codex',
  'o3',
  'o1',
  'codex-mini',
])

function column(partial: Partial<AzureFeatureColumn> = {}): AzureFeatureColumn {
  return {
    capabilities: ['reasoning'],
    modalities: null,
    chatCompletions: true,
    responses: true,
    effort: true,
    effortIncludesNone: false,
    developerMessages: true,
    maxCompletionTokens: true,
    ...partial,
  }
}

function catalogRow(
  rawId: string,
  partial: Partial<AzureModelRow> = {},
): AzureModelRow {
  return {
    rawId,
    tabulated: true,
    version: null,
    retired: false,
    activity: 'chat',
    contextWindow: 128_000,
    maxOutput: 16_384,
    modalities: null,
    capabilities: [],
    chatCompletions: true,
    responses: true,
    fixedReasoningEffort: false,
    noneExcluded: false,
    ...partial,
  }
}

describe('azure reasoning effort rules', () => {
  const rules = parseAzureEffortRules(EFFORT_RULES)
  const facts = {
    rules,
    columnIds: COLUMN_IDS,
    chatMaxTokens: 'max_completion_tokens' as const,
  }
  const resolved = (
    rawId: string,
    partial: Partial<AzureFeatureColumn> = {},
    row: Partial<AzureModelRow> = {},
  ) => azureModelInfo(catalogRow(rawId, row), column(partial), HASHES, facts)

  it('parses the option restrictions', () => {
    expect(rules).toMatchObject({
      maxFamilies: ['gpt-6', 'gpt-5.6'],
      maxNeedsResponses: true,
      xhighFamilies: [
        'gpt-6',
        'gpt-5.6',
        'gpt-5.5',
        'gpt-5.4',
        'gpt-5.1-codex-max',
      ],
      minimalExcluded: ['gpt-5-codex'],
      noneFamilies: [
        'gpt-5.6',
        'gpt-5.5',
        'gpt-5.4',
        'gpt-5.2',
        'gpt-5.1',
        'gpt-5.1-codex',
        'gpt-5.1-codex-max',
        'gpt-5.1-codex-mini',
      ],
      onlySupports: [{ id: 'gpt-5-pro', level: 'high' }],
    })
  })

  it('throws when the options line is missing', () => {
    expect(() => parseAzureEffortRules('no options here')).toThrow(
      'effort options did not parse',
    )
  })

  it('fills effort lists from the clauses', () => {
    expect(
      resolved('gpt-6-sol', { effortIncludesNone: true }).reasoning,
    ).toEqual({
      mode: 'effort',
      mandatory: false,
      efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    })
    expect(
      resolved('gpt-6.1-sol', { effortIncludesNone: true }).reasoning?.efforts,
    ).toEqual(['none', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(resolved('gpt-5.6-sol').reasoning).toEqual({
      mode: 'effort',
      mandatory: false,
      efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    })
    expect(resolved('gpt-5.5').reasoning?.efforts).toEqual([
      'none',
      'low',
      'medium',
      'high',
      'xhigh',
    ])
    expect(resolved('gpt-5.4').reasoning?.efforts).toEqual([
      'none',
      'low',
      'medium',
      'high',
      'xhigh',
    ])
    expect(resolved('gpt-5.4-mini').reasoning).toEqual({
      mode: 'effort',
      mandatory: null,
      efforts: ['low', 'medium', 'high'],
    })
    expect(resolved('gpt-5.2').reasoning?.efforts).toEqual([
      'none',
      'low',
      'medium',
      'high',
    ])
    expect(resolved('gpt-5.2-codex').reasoning?.efforts).toEqual([
      'low',
      'medium',
      'high',
    ])
    expect(
      resolved('gpt-5.1-codex-max', {}, { noneExcluded: true }).reasoning,
    ).toEqual({
      mode: 'effort',
      mandatory: true,
      efforts: ['low', 'medium', 'high', 'xhigh'],
    })
    expect(resolved('gpt-5-pro').reasoning).toEqual({
      mode: 'effort',
      mandatory: true,
      efforts: ['high'],
    })
    expect(resolved('gpt-5-mini').reasoning?.efforts).toEqual([
      'minimal',
      'low',
      'medium',
      'high',
    ])
    expect(resolved('gpt-5-codex').reasoning).toEqual({
      mode: 'effort',
      mandatory: null,
      efforts: ['low', 'medium', 'high'],
    })
    expect(resolved('o3').reasoning).toEqual({
      mode: 'effort',
      mandatory: null,
      efforts: ['low', 'medium', 'high'],
    })
  })

  it('maps reasoning_effort and leaves the chat token field off responses-only models', () => {
    const sol = resolved('gpt-5.6-sol')
    expect(sol.requestMap).toMatchObject({
      thinking: {
        on: { reasoning_effort: 'high' },
        off: { reasoning_effort: 'none' },
      },
      maxTokensField: 'max_completion_tokens',
      developerRole: true,
      reasoningEffort: true,
    })
    expect(sol.factSources?.reasoning).toMatchObject({
      sourceUrl: AZURE_REASONING_URL,
      path: 'reasoning_effort',
    })
    const pro = resolved('gpt-5.4-pro', {
      chatCompletions: false,
      maxCompletionTokens: false,
    })
    expect(pro.requestMap?.maxTokensField).toBeNull()
    expect(pro.requestMap?.thinking?.off).toBeNull()
  })

  it('records a fixed reasoning level as no effort parameter', () => {
    const latest = resolved(
      'gpt-chat-latest',
      {
        effort: false,
        capabilities: [],
        developerMessages: null,
        maxCompletionTokens: null,
      },
      { fixedReasoningEffort: true, capabilities: ['reasoning'] },
    )
    expect(latest.reasoning).toBeUndefined()
    expect(latest.requestMap).toMatchObject({
      thinking: null,
      reasoningEffort: false,
      maxTokensField: 'max_completion_tokens',
    })
  })
})

describe('azure GPT-4 section prose', () => {
  const page = [
    '::: zone pivot="azure-openai"',
    '',
    '## GPT-4 and GPT-4 Turbo models',
    '',
    'The listed models support the Chat Completions API. GPT-4o versions `2024-05-13`, `2024-08-06`, and `2024-11-20`, and GPT-4o-mini version `2024-07-18`, also support the [Responses API](../../openai/how-to/responses).',
    '',
    '| Model ID | Description | Max request (tokens) | Training data (up to) |',
    '| --- | --- | --- | --- |',
    '| `gpt-4o` (2024-11-20)  GPT-4o (Omni) | - Structured outputs. - Text and image processing. | Input: 128,000  Output: 16,384 | October 2023 |',
    '| `gpt-4o-mini` (2024-07-18)  GPT-4o mini | - Text and image processing. | Input: 128,000  Output: 16,384 | October 2023 |',
    '| `gpt-4`^1^ (turbo-2024-04-09) GPT-4 Turbo with Vision | New generally available model. | Input: 128,000  Output: 4,096 | December 2023 |',
    '| `gpt-5.1-codex-max` (2025-12-04) | - Responses API only. | Input: 128,000 Output: 16,384 | October 2023 |',
    '| `gpt-chat-latest` (2026-08-06) | - Chat Completions API. | Input: 128,000 Output: 16,384 | February 2026 |',
    '',
    "`gpt-chat-latest` uses a fixed, nonzero reasoning level, so it can generate reasoning tokens for some requests. Unlike other reasoning models, you can't configure this level with the `reasoning_effort` parameter.",
    '',
    'Reasoning effort `none` is not supported with `gpt-5.1-codex-max`.',
    '',
    '::: zone-end',
  ].join('\n')
  const rows = parseAzureModels(page)

  it('reads the section API sentence, vision name, and effort notes', () => {
    expect(rows.get('gpt-4')).toMatchObject({
      chatCompletions: true,
      responses: false,
      modalities: { input: ['text', 'image'], output: [] },
    })
    expect(rows.get('gpt-4o')).toMatchObject({
      version: '2024-11-20',
      chatCompletions: true,
      responses: true,
    })
    expect(rows.get('gpt-4o-mini')).toMatchObject({
      chatCompletions: true,
      responses: true,
    })
    expect(rows.get('gpt-chat-latest')?.fixedReasoningEffort).toBe(true)
    expect(rows.get('gpt-5.1-codex-max')?.noneExcluded).toBe(true)
  })
})

describe('azure chat spec max tokens', () => {
  it('reads the deprecation of max_tokens', () => {
    expect(
      azureChatMaxTokensField({
        paths: {
          '/chat/completions': {
            post: {
              requestBody: {
                content: {
                  'application/json': {
                    schema: {
                      properties: {
                        messages: { type: 'array' },
                        max_completion_tokens: { type: 'integer' },
                        max_tokens: {
                          description:
                            'This value is now deprecated in favor of `max_completion_tokens`, and is not compatible with o1 series models.',
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      }),
    ).toBe('max_completion_tokens')
  })

  it('throws when the chat body does not say that', () => {
    expect(() =>
      azureChatMaxTokensField({ paths: { '/chat/completions': {} } }),
    ).toThrow('max_completion_tokens')
  })
})
