import { describe, expect, it } from 'vitest'

import { OPENAI_OPENAPI_URL } from '../openai-compat.ts'
import { provider } from './novita.ts'

const OPENAI_FIXTURE = JSON.stringify({
  openapi: '3.1.0',
  info: { title: 'OpenAI API', version: '2.3.0' },
  servers: [{ url: 'https://api.openai.com/v1' }],
  paths: {
    '/chat/completions': { post: { operationId: 'createChatCompletion' } },
    '/images/generations': { post: { operationId: 'createImage' } },
    '/embeddings': { post: { operationId: 'createEmbedding' } },
    '/files': { get: { operationId: 'listFiles' } },
  },
})

describe('novita adapter', () => {
  it('is a generated OpenAI-compatible adapter for chat and image', () => {
    expect(provider.id).toBe('novita')
    expect(provider.displayName).toBe('Novita AI')
    expect(provider.authEnvVar).toBe('NOVITA_API_KEY')
    expect(provider.defaultDerivation).toBe('generated')
    expect(provider.specSourceUrl).toBe(OPENAI_OPENAPI_URL)
    expect(provider.modelsEndpoint).toBe(
      'https://api.novita.ai/openai/v1/models',
    )
  })

  it('classifies generation paths and drops platform ones', () => {
    expect(provider.classify('/chat/completions', {})).toBe('chat')
    expect(provider.classify('/v1/chat/completions', {})).toBe('chat')
    expect(provider.classify('/images/generations', {})).toBe('image')
    expect(provider.classify('/v1/images/generations', {})).toBe('image')
    expect(provider.classify('/files', {})).toBeNull()
    expect(provider.classify('/v1/models', {})).toBeNull()
    expect(provider.classify('/openai/v1/models', {})).toBeNull()
  })

  it('skips listModels when NOVITA_API_KEY is absent', async () => {
    const { models, skipped } = await provider.listModels({})
    expect(models).toEqual([])
    expect(skipped).toBe('novita: NOVITA_API_KEY not set — skipped')
  })

  it('fetchSpec keeps chat + image paths and rewrites the server', async () => {
    const original = globalThis.fetch
    const urls: Array<string> = []
    globalThis.fetch = ((url: string) => {
      urls.push(String(url))
      expect(String(url)).toBe(OPENAI_OPENAPI_URL)
      return Promise.resolve(
        new Response(OPENAI_FIXTURE, {
          headers: { 'content-type': 'application/json' },
        }),
      )
    }) as typeof fetch
    try {
      const fetched = await provider.fetchSpec({})
      expect(urls).toEqual([OPENAI_OPENAPI_URL])
      expect(fetched.outputStrategy).toBe('post-200')
      expect(fetched.sources).toHaveLength(1)
      expect(fetched.sources[0]?.url).toBe(OPENAI_OPENAPI_URL)
      expect(fetched.sources[0]?.hash).toMatch(/^[0-9a-f]{64}$/)
      const spec = fetched.specs[0]
      expect(spec?.info?.title).toBe('Novita AI')
      expect(spec?.servers).toEqual([
        { url: 'https://api.novita.ai/openai/v1' },
      ])
      expect(Object.keys(spec?.paths ?? {})).toEqual([
        '/chat/completions',
        '/images/generations',
      ])
    } finally {
      globalThis.fetch = original
    }
  })
})
