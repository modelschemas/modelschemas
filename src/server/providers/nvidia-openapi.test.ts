import { describe, expect, it } from 'vitest'

import {
  nvidiaMaxOutput,
  nvidiaModelSpec,
  nvidiaReasoning,
  parseNvidiaInfer,
  parseNvidiaReferenceIndex,
} from './nvidia-openapi.ts'

/** Excerpt of https://docs.api.nvidia.com/nim/reference/llm-apis.md (2026-10-07). */
const INDEX = `---
updatedAt: 2026-10-05T22:07:01.000Z
---

| Model | Endpoint |
| --- | --- |
| [deepseek-ai / deepseek-v4-flash](https://docs.api.nvidia.com/nim/reference/deepseek-ai-deepseek-v4-flash) | [chat](https://docs.api.nvidia.com/nim/reference/deepseek-ai-deepseek-v4-flash-infer) |
| [moonshot ai / kimi-k2.6](https://docs.api.nvidia.com/nim/reference/moonshotai-kimi-k2-6) | [chat](https://docs.api.nvidia.com/nim/reference/moonshotai-kimi-k2-6-infer) |
| [z-ai / glm-5.2](ref:z-ai-glm-5.2) | [chat](ref:z-ai-glm-5.2-infer) |
| [snowflake / arctic-embed-l](https://docs.api.nvidia.com/nim/reference/snowflake-arctic-embed-l) | [status](https://docs.api.nvidia.com/nim/reference/snowflake-arctic-embed-l-statuspolling) |
| [nvidia / nemotron-3-nano-omni-30b-a3b-reasoning](https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3-nano-omni-30b-a3b-reasoning) | [chat](https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3-nano-omni-30b-a3b-reasoning) |
`

function inferDoc(
  properties: Record<string, unknown>,
  path = '/chat/completions',
): string {
  return `# OpenAPI definition

\`\`\`json
${JSON.stringify({
  openapi: '3.1.0',
  info: { title: 'NVIDIA NIM API' },
  paths: {
    [path]: {
      post: {
        requestBody: {
          content: {
            'application/json': {
              schema: { type: 'object', properties },
            },
          },
        },
      },
    },
  },
})}
\`\`\`
`
}

describe('parseNvidiaReferenceIndex', () => {
  it('reads listing ids and infer links, including ref: rows', () => {
    expect(parseNvidiaReferenceIndex(INDEX)).toEqual([
      {
        rawId: 'deepseek-ai/deepseek-v4-flash',
        inferUrl:
          'https://docs.api.nvidia.com/nim/reference/deepseek-ai-deepseek-v4-flash-infer',
      },
      {
        rawId: 'moonshotai/kimi-k2.6',
        inferUrl:
          'https://docs.api.nvidia.com/nim/reference/moonshotai-kimi-k2-6-infer',
      },
      {
        rawId: 'z-ai/glm-5.2',
        inferUrl:
          'https://docs.api.nvidia.com/nim/reference/z-ai-glm-5.2-infer',
      },
      {
        rawId: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
        inferUrl:
          'https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3-nano-omni-30b-a3b-reasoning-infer',
      },
    ])
  })

  it('throws when the page is not a reference index', () => {
    expect(() =>
      parseNvidiaReferenceIndex('<html>Just a moment</html>'),
    ).toThrow('not markdown')
  })
})

describe('parseNvidiaInfer', () => {
  it('reads an anyOf max_tokens cap and an effort enum', () => {
    const facts = parseNvidiaInfer(
      inferDoc({
        max_tokens: {
          anyOf: [
            { type: 'integer', maximum: 65536, minimum: 1 },
            { type: 'null' },
          ],
          description: 'The maximum number of tokens that can be generated.',
        },
        reasoning_effort: { enum: ['low', 'high', 'max'], default: 'max' },
      }),
    )
    expect(facts).toMatchObject({
      activity: 'chat',
      maxOutput: 65536,
      reasoning: {
        mode: 'effort',
        mandatory: null,
        efforts: ['low', 'high', 'max'],
      },
    })
  })

  it('reads a reasoning budget and an off effort', () => {
    expect(
      nvidiaReasoning(
        parseNvidiaInfer(
          inferDoc({
            reasoning_budget: {
              type: 'integer',
              maximum: 32768,
              minimum: -1,
              description: 'Use -1 to disable budget enforcement.',
            },
            max_tokens: {
              type: 'integer',
              maximum: 32768,
              description: 'The maximum number of tokens to generate.',
            },
          }),
        )!.document,
      ),
    ).toEqual({ mode: 'budget', mandatory: null })
    expect(
      nvidiaReasoning(
        parseNvidiaInfer(
          inferDoc({
            reasoning_effort: { enum: ['none', 'high', 'max'] },
          }),
        )!.document,
      ),
    ).toEqual({
      mode: 'effort',
      mandatory: false,
      efforts: ['none', 'high', 'max'],
    })
  })

  it('reads a chat_template_kwargs description that states thinking on and off', () => {
    expect(
      nvidiaReasoning(
        parseNvidiaInfer(
          inferDoc({
            chat_template_kwargs: {
              anyOf: [{ type: 'object' }, { type: 'null' }],
              description:
                'Optional kwargs forwarded to the model chat template (e.g. {"thinking": true} / {"thinking": false}).',
            },
          }),
        )!.document,
      ),
    ).toEqual({ mode: 'toggle', mandatory: false })
  })

  it('follows a component ref for max_tokens', () => {
    const markdown = `# OpenAPI definition

\`\`\`json
${JSON.stringify({
  openapi: '3.1.0',
  paths: {
    '/chat/completions': {
      post: {
        requestBody: {
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Request' },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Request: {
        type: 'object',
        properties: {
          max_tokens: {
            type: 'integer',
            maximum: 4096,
            description: 'The maximum number of tokens to generate.',
          },
        },
      },
    },
  },
})}
\`\`\`
`
    const facts = parseNvidiaInfer(markdown)
    expect(nvidiaMaxOutput(facts!.document)).toBe(4096)
    expect(nvidiaModelSpec('openai/gpt-oss-20b', facts!)?.paths).toHaveProperty(
      '/openai/gpt-oss-20b',
    )
  })

  it('returns null when the page has no OpenAPI document', () => {
    expect(parseNvidiaInfer('# Model\n\n```json\n"not a spec"\n```')).toBeNull()
  })
})
