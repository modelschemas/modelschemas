import { describe, expect, it } from 'vitest'

import { provider } from './groq.ts'

describe('groq classify', () => {
  it('maps generation paths and drops platform surfaces', () => {
    expect(provider.classify('/openai/v1/chat/completions', {})).toBe('chat')
    expect(provider.classify('/openai/v1/responses', {})).toBe('chat')
    expect(provider.classify('/openai/v1/audio/speech', {})).toBe('audio')
    expect(provider.classify('/openai/v1/audio/transcriptions', {})).toBe(
      'audio',
    )
    expect(provider.classify('/openai/v1/audio/translations', {})).toBe('audio')
    expect(provider.classify('/openai/v1/embeddings', {})).toBe('embeddings')
    expect(provider.classify('/openai/v1/batches', {})).toBeNull()
    expect(provider.classify('/openai/v1/files', {})).toBeNull()
    expect(provider.classify('/openai/v1/reranking', {})).toBeNull()
    expect(provider.classify('/v1/fine_tunings', {})).toBeNull()
    expect(provider.classify('/openai/v1/models', {})).toBeNull()
  })
})

describe('groq listModels', () => {
  it('skips with an empty catalog when GROQ_API_KEY is absent', async () => {
    const result = await provider.listModels({})
    expect(result.models).toEqual([])
    expect(result.skipped).toBe('groq: GROQ_API_KEY not set — skipped')
  })
})

describe('groq fetchSpec', () => {
  it('resolves the Stainless spec URL from groq-python .stats.yml', async () => {
    const original = globalThis.fetch
    const specYaml = [
      'openapi: 3.0.1',
      'info:',
      '  title: GroqCloud API',
      'paths:',
      '  /openai/v1/chat/completions:',
      '    post:',
      '      summary: chat',
      '',
    ].join('\n')
    const specUrl =
      'https://storage.googleapis.com/stainless-sdk-openapi-specs/groqcloud/fixture.yml'
    globalThis.fetch = ((url: string) => {
      const href = String(url)
      if (href === provider.specSourceUrl) {
        return Promise.resolve(new Response(`openapi_spec_url: ${specUrl}\n`))
      }
      if (href === specUrl) {
        return Promise.resolve(new Response(specYaml))
      }
      return Promise.resolve(new Response('not found', { status: 404 }))
    }) as typeof fetch
    try {
      const fetched = await provider.fetchSpec({})
      expect(fetched.outputStrategy).toBe('post-200')
      expect(fetched.specRevision).toBe(specUrl)
      expect(fetched.specs).toHaveLength(1)
      expect(fetched.specs[0]?.info?.title).toBe('GroqCloud API')
      expect(fetched.sources[0]?.url).toBe(specUrl)
      expect(fetched.sources[0]?.hash).toMatch(/^[0-9a-f]{64}$/)
    } finally {
      globalThis.fetch = original
    }
  })
})
