import { describe, expect, it } from 'vitest'

import chatSpec from '../fixtures/jina-chat-openapi.json'
import { provider } from './jina.ts'

describe('jina provider', () => {
  it('exports the jina adapter with seed metadata', () => {
    expect(provider.id).toBe('jina')
    expect(provider.displayName).toBe('Jina AI')
    expect(provider.authEnvVar).toBe('JINA_API_KEY')
    expect(provider.specSourceUrl).toBe('https://api.jina.ai/openapi.json')
    expect(provider.modelsEndpoint).toBe('https://api.jina.ai/v1/models')
    expect(provider.defaultDerivation).toBe('upstream-spec')
  })
})

describe('jina classify', () => {
  it('maps embeddings and chat, and drops rerank/classifier/platform', () => {
    expect(provider.classify('/v1/embeddings', {})).toBe('embeddings')
    expect(provider.classify('/embeddings', {})).toBe('embeddings')
    expect(provider.classify('/v1/chat/completions', {})).toBe('chat')
    expect(provider.classify('/v1/rerank', {})).toBeNull()
    expect(provider.classify('/v1/classify', {})).toBeNull()
    expect(provider.classify('/v1/train', {})).toBeNull()
    expect(provider.classify('/v1/reader', {})).toBeNull()
    expect(provider.classify('/v1/models', {})).toBeNull()
  })
})

describe('jina listModels', () => {
  it('skips when JINA_API_KEY is absent', async () => {
    const original = globalThis.fetch
    globalThis.fetch = () => {
      throw new Error('fetch')
    }
    try {
      const result = await provider.listModels({})
      expect(result.skipped).toBe('jina: JINA_API_KEY not set — skipped')
      expect(result.models).toEqual([])
    } finally {
      globalThis.fetch = original
    }
  })

  it('classifies chat from the OpenAPI model const and maps that request', async () => {
    const original = globalThis.fetch
    globalThis.fetch = ((url: string) => {
      const body =
        String(url) === 'https://api.jina.ai/openapi.json'
          ? chatSpec
          : {
              data: [
                {
                  id: 'jina-ai/jina-ocr-v1',
                  output_modalities: ['text'],
                  input_modalities: ['text', 'image'],
                  context_length: 32768,
                  max_output_length: 8192,
                  pricing: { prompt: '0.0000005', completion: '0.000002' },
                },
                {
                  id: 'jina-ai/ReaderLM-v2',
                  output_modalities: ['text'],
                  input_modalities: ['text'],
                  context_length: 524288,
                  max_output_length: 0,
                  pricing: { prompt: '0.00000005', completion: '0' },
                },
                {
                  id: 'jina-embeddings-v3',
                  output_modalities: ['embeddings'],
                  pricing: { prompt: '0.00000005', completion: '0' },
                },
                {
                  id: 'jina-reranker-v3',
                  output_modalities: ['text'],
                  pricing: { prompt: '0', completion: '0' },
                },
              ],
            }
      return Promise.resolve(
        new Response(JSON.stringify(body), { status: 200 }),
      )
    }) as typeof fetch
    try {
      const { models } = await provider.listModels({ JINA_API_KEY: 'test' })
      const ocr = models.find((model) => model.rawId.endsWith('jina-ocr-v1'))
      const reader = models.find((model) => model.rawId.endsWith('ReaderLM-v2'))
      const embed = models.find((model) => model.rawId.includes('embeddings'))
      const rerank = models.find((model) => model.rawId.includes('reranker'))
      expect(ocr?.activity).toBe('chat')
      expect(ocr?.maxOutput).toBe(8192)
      expect(ocr?.requestMap).toMatchObject({
        maxTokensField: 'max_completion_tokens',
        developerRole: true,
        reasoningEffort: null,
      })
      expect(reader?.activity ?? null).toBeNull()
      expect(reader?.requestMap).toBeUndefined()
      expect(reader?.maxOutput).toBeUndefined()
      expect(embed?.activity).toBe('embeddings')
      expect(rerank?.activity ?? null).toBeNull()
      expect(rerank?.requestMap).toBeUndefined()
    } finally {
      globalThis.fetch = original
    }
  })

  it('throws when the chat schema names no model and does not list models', async () => {
    const original = globalThis.fetch
    const urls: Array<string> = []
    globalThis.fetch = ((url: string) => {
      urls.push(String(url))
      return Promise.resolve(
        new Response(
          JSON.stringify({ openapi: '3.1.0', components: { schemas: {} } }),
          { status: 200 },
        ),
      )
    }) as typeof fetch
    try {
      await expect(
        provider.listModels({ JINA_API_KEY: 'test' }),
      ).rejects.toThrow(/ChatCompletionRequest missing/)
      expect(urls).toEqual(['https://api.jina.ai/openapi.json'])
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('jina fetchSpec', () => {
  it('parses the public OpenAPI document without hitting the network', async () => {
    const original = globalThis.fetch
    const spec = {
      openapi: '3.1.0',
      info: { title: 'Jina Search Foundation API', version: '1.0.0' },
      paths: {
        '/v1/embeddings': { post: { operationId: 'createEmbedding' } },
      },
    }
    const urls: Array<string> = []
    globalThis.fetch = ((url: string) => {
      urls.push(String(url))
      return Promise.resolve(
        new Response(JSON.stringify(spec), { status: 200 }),
      )
    }) as typeof fetch
    try {
      const fetched = await provider.fetchSpec({})
      expect(urls).toEqual(['https://api.jina.ai/openapi.json'])
      expect(fetched.outputStrategy).toBe('post-200')
      expect(fetched.specs).toHaveLength(1)
      expect(fetched.specs[0]?.paths?.['/v1/embeddings']).toBeDefined()
      expect(fetched.sources[0]?.url).toBe('https://api.jina.ai/openapi.json')
      expect(fetched.sources[0]?.hash).toMatch(/^[0-9a-f]{64}$/)
    } finally {
      globalThis.fetch = original
    }
  })
})
