import { describe, expect, it } from 'vitest'

import { OPENAI_OPENAPI_URL } from '../openai-compat.ts'
import type { OpenApiDocument } from '../types.ts'
import { provider } from './sambanova.ts'

const OPENAI_FIXTURE: OpenApiDocument = {
  openapi: '3.1.0',
  info: { title: 'OpenAI API', version: '2.3.0' },
  servers: [{ url: 'https://api.openai.com/v1' }],
  paths: {
    '/chat/completions': { post: { operationId: 'createChatCompletion' } },
    '/embeddings': { post: { operationId: 'createEmbedding' } },
    '/files': { get: { operationId: 'listFiles' } },
  },
}

describe('sambanova provider', () => {
  it('is the generated SambaNova adapter', () => {
    expect(provider.id).toBe('sambanova')
    expect(provider.displayName).toBe('SambaNova')
    expect(provider.authEnvVar).toBe('SAMBANOVA_API_KEY')
    expect(provider.defaultDerivation).toBe('generated')
    expect(provider.specSourceUrl).toBe(OPENAI_OPENAPI_URL)
    expect(provider.modelsEndpoint).toBe('https://api.sambanova.ai/v1/models')
  })
})

describe('sambanova classify', () => {
  it('maps chat completions and drops platform paths', () => {
    expect(provider.classify('/chat/completions', {})).toBe('chat')
    expect(provider.classify('/v1/chat/completions', {})).toBe('chat')
    expect(provider.classify('/v1/models', {})).toBeNull()
    expect(provider.classify('/files', {})).toBeNull()
  })
})

describe('sambanova listModels', () => {
  it('skips when SAMBANOVA_API_KEY is absent', async () => {
    const result = await provider.listModels({})
    expect(result.models).toEqual([])
    expect(result.skipped).toBe(
      'sambanova: SAMBANOVA_API_KEY not set — skipped',
    )
  })
})

describe('sambanova fetchSpec', () => {
  it('keeps chat/completions and rewrites the server to SambaNova', async () => {
    const original = globalThis.fetch
    const urls: Array<string> = []
    globalThis.fetch = ((url: string) => {
      urls.push(String(url))
      return Promise.resolve(
        new Response(JSON.stringify(OPENAI_FIXTURE), {
          status: 200,
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
      expect(spec?.info?.title).toBe('SambaNova')
      expect(spec?.servers).toEqual([{ url: 'https://api.sambanova.ai/v1' }])
      expect(Object.keys(spec?.paths ?? {})).toEqual(['/chat/completions'])
    } finally {
      globalThis.fetch = original
    }
  })
})
