import { describe, expect, it } from 'vitest'

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
  it('maps embeddings paths and drops rerank/classifier/reader/platform', () => {
    expect(provider.classify('/v1/embeddings', {})).toBe('embeddings')
    expect(provider.classify('/embeddings', {})).toBe('embeddings')
    expect(provider.classify('/v1/rerank', {})).toBeNull()
    expect(provider.classify('/v1/classify', {})).toBeNull()
    expect(provider.classify('/v1/train', {})).toBeNull()
    expect(provider.classify('/v1/reader', {})).toBeNull()
    expect(provider.classify('/v1/models', {})).toBeNull()
  })
})

describe('jina listModels', () => {
  it('skips when JINA_API_KEY is absent', async () => {
    const result = await provider.listModels({})
    expect(result.skipped).toBe('jina: JINA_API_KEY not set — skipped')
    expect(result.models).toEqual([])
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
