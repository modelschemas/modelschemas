import { describe, expect, it } from 'vitest'

import { provider } from './adapters/sambanova.ts'
import {
  parseSambanovaChatFlags,
  parseSambanovaModelModalities,
  parseSambanovaToolModels,
  sambanovaDocsPatch,
  SAMBANOVA_MODELS_DOCS_URL,
  SAMBANOVA_SPEC_URL,
  SAMBANOVA_TOOLS_DOCS_URL,
} from './sambanova-docs.ts'

const MODELS_PAGE = `
# SambaCloud models overview and specifications

## Production models

| **Developer** | **Model ID** | **Context length** | **Supported modalities** | **View on Hugging Face** |
| :- | :- | :- | :- | :- |
| **MiniMax** | \`MiniMax-M2.7\` | 192k tokens | Text | [Model card](https://huggingface.co/MiniMaxAI/MiniMax-M2.7) |
| **DeepSeek** | \`DeepSeek-V3.1\` | 128k tokens | Text | [Model card](https://huggingface.co/deepseek-ai/DeepSeek-V3.1) |
| **Meta** | \`Meta-Llama-3.3-70B-Instruct\` | 128k tokens | Text | [Model card](https://huggingface.co/meta-llama/Llama-3.3-70B-Instruct) |
| **OpenAI** | \`gpt-oss-120b\` | 128k tokens | Text | [Model card](https://huggingface.co/openai/gpt-oss-120b) |

## Preview models

| **Developer** | **Model ID** | **Context length** | **Supported modalities** | **View on Hugging Face** |
| :- | :- | :- | :- | :- |
| **MiniMax** | \`MiniMax-M3\` | 1M tokens | Text | [Model card](https://huggingface.co/MiniMaxAI/MiniMax-M3) |
| **DeepSeek** | \`DeepSeek-V3.2\` | 32k tokens | Text | [Model card](https://huggingface.co/deepseek-ai/DeepSeek-V3.2) |
| **Google** | \`gemma-4-31B-it\` | 128k tokens | Text, Image, Video | [Model card](https://huggingface.co/google/gemma-4-31B-it) |
`

const TOOLS_PAGE = `
## Supported models

* \`Meta-Llama-3.3-70B-Instruct\`
* \`gpt-oss-120b\`
* \`DeepSeek-V3.1\`
* \`DeepSeek-V3.2\`
* \`MiniMax-M2.7\`
* \`MiniMax-M3\`
* \`gemma-4-31B-it\`

<Note>
  To get better quality in tool calling requests with \`gpt-oss-120b\`, set the \`reasoning_effort\` to \`high\`.
</Note>

## Example usage
`

const CHAT_SPEC = {
  components: {
    schemas: {
      ChatCompletionRequest: {
        properties: {
          max_tokens: {
            description: 'The maximum number of tokens that can be generated.',
          },
          max_completion_tokens: {
            description: 'The maximum number of tokens that can be generated.',
          },
          temperature: { description: 'Sampling temperature.' },
          top_p: { description: 'Nucleus sampling.' },
          top_k: { description: 'Top-k sampling.' },
          presence_penalty: {
            description:
              'Not currently implemented; accepted for API compatibility',
          },
          frequency_penalty: {
            description:
              'Not currently implemented; accepted for API compatibility',
          },
          repetition_penalty: {
            description:
              'Only supported for some models (currently MiniMax and gpt-oss models); silently ignored on models that do not support it.',
          },
          stop: { description: 'Stop sequences.' },
          response_format: {
            description:
              'Setting to `{ "type": "json_schema", "json_schema": {<your_schema>}"}` enables JSON schema mode.',
          },
          reasoning_effort: {
            description: "allowed values are 'low', 'medium', 'high'",
            enum: ['low', 'medium', 'high'],
          },
          tool_choice: { description: 'Which tool is called.' },
          tools: { description: 'Tools the model may call.' },
          seed: { description: 'Best-effort deterministic sampling.' },
        },
      },
    },
  },
}

const TEXT = { input: ['text'], output: ['text'] }
const GEMMA = { input: ['text', 'image', 'video'], output: ['text'] }

describe('parseSambanovaModelModalities', () => {
  it('reads both tables and treats image and video as inputs', () => {
    const rows = parseSambanovaModelModalities(MODELS_PAGE)
    expect(rows.get('DeepSeek-V3.1')).toEqual(TEXT)
    expect(rows.get('MiniMax-M3')).toEqual(TEXT)
    expect(rows.get('gemma-4-31B-it')).toEqual(GEMMA)
    expect(rows.size).toBe(7)
  })

  it('throws when the table is missing or a modality is unknown', () => {
    expect(() => parseSambanovaModelModalities('# no table')).toThrow(
      /no modalities table/,
    )
    expect(() =>
      parseSambanovaModelModalities(
        MODELS_PAGE.replace('Text, Image, Video', 'Text, Hologram'),
      ),
    ).toThrow(/unknown modality/)
  })
})

describe('parseSambanovaToolModels', () => {
  it('reads the supported-models bullets and ignores the note', () => {
    expect([...parseSambanovaToolModels(TOOLS_PAGE)].sort()).toEqual([
      'DeepSeek-V3.1',
      'DeepSeek-V3.2',
      'Meta-Llama-3.3-70B-Instruct',
      'MiniMax-M2.7',
      'MiniMax-M3',
      'gemma-4-31B-it',
      'gpt-oss-120b',
    ])
  })

  it('throws when the section names no ids', () => {
    expect(() =>
      parseSambanovaToolModels('## Supported models\n\n## Example usage\n'),
    ).toThrow(/no model ids/)
  })
})

describe('parseSambanovaChatFlags', () => {
  it('keeps implemented fields and drops unimplemented ones', () => {
    expect(parseSambanovaChatFlags(CHAT_SPEC)).toEqual([
      'tools',
      'tool_choice',
      'max_tokens',
      'temperature',
      'top_p',
      'top_k',
      'stop',
      'seed',
      'response_format',
      'structured_outputs',
      'reasoning_effort',
    ])
  })

  it('throws when the chat schema is missing', () => {
    expect(() => parseSambanovaChatFlags({ components: {} })).toThrow(
      /ChatCompletionRequest/,
    )
  })
})

describe('sambanovaDocsPatch', () => {
  const loaded = {
    modalities: {
      byId: Object.fromEntries(parseSambanovaModelModalities(MODELS_PAGE)),
      hash: 'models',
    },
    flags: { flags: parseSambanovaChatFlags(CHAT_SPEC), hash: 'spec' },
    tools: { ids: [...parseSambanovaToolModels(TOOLS_PAGE)], hash: 'tools' },
  }

  it('attaches text modalities and drops seed on gemma', () => {
    const llama = sambanovaDocsPatch('Meta-Llama-3.3-70B-Instruct', loaded)
    expect(llama.modalities).toEqual(TEXT)
    expect(llama.capabilities).toContain('seed')
    expect(llama.capabilities).toContain('tools')
    expect(llama.exactCapabilities).toBe(true)
    expect(llama.factSources?.modalities).toMatchObject({
      derivation: 'docs-derived',
      sourceUrl: SAMBANOVA_MODELS_DOCS_URL,
    })
    expect(llama.factSources?.capabilities?.tools).toMatchObject({
      derivation: 'docs-derived',
      sourceUrl: SAMBANOVA_TOOLS_DOCS_URL,
    })
    expect(llama.factSources?.capabilities?.temperature).toMatchObject({
      derivation: 'upstream-spec',
      sourceUrl: SAMBANOVA_SPEC_URL,
    })

    const gemma = sambanovaDocsPatch('gemma-4-31B-it', loaded)
    expect(gemma.modalities).toEqual(GEMMA)
    expect(gemma.capabilities).not.toContain('seed')
    expect(gemma.capabilities).toContain('tools')
  })

  it('omits tools for an id the function-calling page does not list', () => {
    const patch = sambanovaDocsPatch('not-a-tool-model', {
      ...loaded,
      modalities: {
        byId: { 'not-a-tool-model': TEXT },
        hash: 'models',
      },
    })
    expect(patch.capabilities).not.toContain('tools')
    expect(patch.capabilities).not.toContain('tool_choice')
    expect(patch.capabilities).toContain('temperature')
  })

  it('keeps stored facts when a source failed to load', () => {
    expect(
      sambanovaDocsPatch('gemma-4-31B-it', {
        modalities: null,
        flags: null,
        tools: null,
      }).absent,
    ).toEqual({ modalities: 'unavailable', capabilities: 'unavailable' })
  })
})

describe('sambanova listModels docs', () => {
  it('joins the listing to the models page and the chat schema', async () => {
    const original = globalThis.fetch
    globalThis.fetch = ((url: string) => {
      const href = String(url)
      const body = href.includes('/v1/models')
        ? JSON.stringify({
            data: [
              {
                id: 'gemma-4-31B-it',
                context_length: 262144,
                max_completion_tokens: 262144,
                pricing: {
                  prompt: '0.00000038',
                  completion: '0.00000115',
                },
              },
              {
                id: 'MiniMax-M3',
                context_length: 1048576,
                max_completion_tokens: 1048576,
                pricing: {
                  prompt: '0.00000060',
                  completion: '0.00000240',
                  input_cache_read: '0.00000006',
                  input_cache_write: '0.00000000',
                },
              },
            ],
          })
        : href.endsWith('/sambacloud-models.md')
          ? MODELS_PAGE
          : href.endsWith('/function-calling.md')
            ? TOOLS_PAGE
            : JSON.stringify(CHAT_SPEC)
      return Promise.resolve(new Response(body, { status: 200 }))
    }) as typeof fetch
    try {
      const { models } = await provider.listModels({
        SAMBANOVA_API_KEY: 'test',
      })
      const gemma = models.find((model) => model.rawId === 'gemma-4-31B-it')
      const minimax = models.find((model) => model.rawId === 'MiniMax-M3')
      expect(gemma?.modalities).toEqual(GEMMA)
      expect(gemma?.capabilities).not.toContain('seed')
      expect(gemma?.capabilities).toContain('reasoning_effort')
      expect(gemma?.contextWindow).toBe(262144)
      expect(minimax?.modalities).toEqual(TEXT)
      expect(minimax?.capabilities).toContain('seed')
      const card = minimax?.pricing as {
        tables?: { rate?: { base?: Record<string, number> } }
      }
      expect(card.tables?.rate?.base?.cache_read_tokens).toBeCloseTo(
        0.00000006,
        12,
      )
      expect(card.tables?.rate?.base?.cache_write_tokens).toBeUndefined()
    } finally {
      globalThis.fetch = original
    }
  })
})
