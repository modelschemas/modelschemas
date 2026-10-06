import { describe, expect, it } from 'vitest'

import {
  AZURE_MODELS_URL,
  AZURE_REASONING_URL,
  azureModelInfo,
  parseAzureFeatureMatrix,
  parseAzureModels,
} from './azure-models.ts'

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
  '## O-Series models',
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
| **Feature** | **gpt-5.4-pro** | **gpt-5.2-codex**,**2026-01-14** |
| --- | --- | --- |
| **[Structured Outputs](structured-outputs)** | ✅ | ✅ |
| **Reasoning effort**^7^ | ✅ | ✅ |
| **[Image input](gpt-with-vision)** | ✅ | ✅ |
| Chat Completions API | - | - |
| Responses API | ✅ | ✅ |
| Functions/Tools | ✅^9^ | ✅ |

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
      'o3-mini',
      'o1-mini',
      'gpt-4o',
      'text-embedding-3-large',
      'gpt-image-2',
      'gpt-audio',
      'gpt-audio-mini',
    ])
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
      contextWindow: 1_047_576,
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
