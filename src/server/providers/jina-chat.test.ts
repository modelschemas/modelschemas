import { describe, expect, it } from 'vitest'

import spec from './fixtures/jina-chat-openapi.json'
import { jinaModelActivity } from './model-meta.ts'
import { jinaChatModel, parseJinaChatRequest } from './jina-chat.ts'

const CHAT = {
  openapi: '3.1.0',
  components: {
    schemas: {
      ChatCompletionRequest: {
        type: 'object',
        properties: {
          messages: {
            type: 'array',
            items: { $ref: '#/components/schemas/ChatMessage' },
          },
          model: { type: 'string', const: 'jina-ocr-v1' },
          max_completion_tokens: { type: 'integer', minimum: 1 },
        },
        required: ['messages', 'model'],
      },
      ChatMessage: {
        type: 'object',
        properties: {
          role: {
            type: 'string',
            enum: ['system', 'developer', 'user', 'assistant'],
          },
        },
      },
    },
  },
}

function request(
  model: unknown,
  extra: Record<string, unknown> = {},
  role?: unknown,
): unknown {
  return {
    components: {
      schemas: {
        ChatCompletionRequest: {
          type: 'object',
          properties: {
            messages: {
              type: 'array',
              items: {
                type: 'object',
                properties: role ? { role } : {},
              },
            },
            model,
            max_completion_tokens: { type: 'integer' },
            ...extra,
          },
        },
      },
    },
  }
}

describe('parseJinaChatRequest', () => {
  it('reads the published chat body', () => {
    const parsed = parseJinaChatRequest(spec)
    expect([...parsed.modelIds]).toEqual(['jina-ocr-v1'])
    expect(parsed.requestMap).toEqual({
      thinking: null,
      maxTokensField: 'max_completion_tokens',
      developerRole: true,
      replayReasoningContent: null,
      store: null,
      strictTools: null,
      sessionAffinity: null,
      cacheControl: null,
      toolStream: null,
      reasoningEffort: null,
    })
  })

  it('accepts an enum and anyOf consts', () => {
    const enumed = parseJinaChatRequest(
      request({ type: 'string', enum: ['jina-ocr-v1', 'jina-ocr-v2'] }),
    )
    expect([...enumed.modelIds]).toEqual(['jina-ocr-v1', 'jina-ocr-v2'])
    const union = parseJinaChatRequest(
      request({
        anyOf: [{ const: 'jina-ocr-v1' }, { const: 'reader-lm-v2' }],
      }),
    )
    expect([...union.modelIds]).toEqual(['jina-ocr-v1', 'reader-lm-v2'])
  })

  it('leaves developerRole null when the role enum is absent', () => {
    expect(
      parseJinaChatRequest(request({ const: 'jina-ocr-v1' })).requestMap
        .developerRole,
    ).toBeNull()
  })

  it('sets developerRole false when the enum rejects developer', () => {
    const parsed = parseJinaChatRequest(
      request({ const: 'jina-ocr-v1' }, {}, { enum: ['user', 'assistant'] }),
    )
    expect(parsed.requestMap.developerRole).toBe(false)
  })

  it('uses max_tokens when that is the only cap', () => {
    const parsed = parseJinaChatRequest({
      components: {
        schemas: {
          ChatCompletionRequest: {
            properties: {
              model: { const: 'jina-ocr-v1' },
              max_tokens: { type: 'integer' },
            },
          },
        },
      },
    })
    expect(parsed.requestMap.maxTokensField).toBe('max_tokens')
  })

  it('throws when the chat body is missing, nameless, or double-capped', () => {
    expect(() => parseJinaChatRequest({ components: { schemas: {} } })).toThrow(
      /ChatCompletionRequest missing/,
    )
    expect(() => parseJinaChatRequest(request({ type: 'string' }))).toThrow(
      /names no model/,
    )
    expect(() =>
      parseJinaChatRequest(
        request({ const: 'jina-ocr-v1' }, { max_tokens: { type: 'integer' } }),
      ),
    ).toThrow(/both max_tokens and max_completion_tokens/)
  })
})

describe('jina chat activity', () => {
  const ids = parseJinaChatRequest(CHAT).modelIds

  it('matches the named id or the segment after the last slash', () => {
    expect(jinaChatModel('jina-ocr-v1', ids)).toBe(true)
    expect(jinaChatModel('jina-ai/jina-ocr-v1', ids)).toBe(true)
    expect(jinaChatModel('jina-ocr-v1-preview', ids)).toBe(false)
    expect(jinaChatModel('jina-ai/ReaderLM-v2', ids)).toBe(false)
  })

  it('classifies only spec-named models as chat', () => {
    expect(
      jinaModelActivity(
        { id: 'jina-ai/jina-ocr-v1', output_modalities: ['text'] },
        ids,
      ),
    ).toBe('chat')
    expect(
      jinaModelActivity(
        { id: 'jina-ai/ReaderLM-v2', output_modalities: ['text'] },
        ids,
      ),
    ).toBeNull()
    expect(
      jinaModelActivity({ id: 'jina-vlm', output_modalities: ['text'] }, ids),
    ).toBeNull()
    expect(
      jinaModelActivity(
        { id: 'jina-embeddings-v3', output_modalities: ['embeddings'] },
        ids,
      ),
    ).toBe('embeddings')
    expect(
      jinaModelActivity(
        { id: 'jina-reranker-v3', output_modalities: ['text'] },
        ids,
      ),
    ).toBeNull()
    expect(
      jinaModelActivity(
        { id: 'jina-colbert-v2', output_modalities: ['embeddings'] },
        ids,
      ),
    ).toBe('embeddings')
  })
})
