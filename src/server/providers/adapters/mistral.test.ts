import { describe, expect, it } from 'vitest'

import { provider } from './mistral.ts'

describe('mistral classify', () => {
  it('maps generation paths to the claimed activities', () => {
    expect(provider.classify('/v1/chat/completions', {})).toBe('chat')
    expect(provider.classify('/v1/fim/completions', {})).toBe('chat')
    expect(provider.classify('/v1/agents/completions', {})).toBe('chat')
    expect(provider.classify('/v1/embeddings', {})).toBe('embeddings')
    expect(provider.classify('/v1/moderations', {})).toBe('moderation')
    expect(provider.classify('/v1/chat/moderations', {})).toBe('moderation')
    expect(provider.classify('/v1/audio/transcriptions', {})).toBe('audio')
    expect(provider.classify('/v1/audio/transcriptions#stream', {})).toBe(
      'audio',
    )
    expect(provider.classify('/v1/audio/speech', {})).toBe('audio')
  })

  it('drops platform, admin, files, fine-tune, batch, and classifiers that are not moderation', () => {
    expect(provider.classify('/v1/files', {})).toBeNull()
    expect(
      provider.classify('/v1/fine_tuning/models/{model_id}', {}),
    ).toBeNull()
    expect(provider.classify('/v1/batch/jobs', {})).toBeNull()
    expect(provider.classify('/v1/admin/users', {})).toBeNull()
    expect(provider.classify('/v1/agents', {})).toBeNull()
    expect(provider.classify('/v1/conversations', {})).toBeNull()
    expect(provider.classify('/v1/ocr', {})).toBeNull()
    expect(provider.classify('/v1/classifications', {})).toBeNull()
    expect(provider.classify('/v1/chat/classifications', {})).toBeNull()
    expect(provider.classify('/v1/models', {})).toBeNull()
  })
})

describe('mistral listModels', () => {
  it('skips with an empty catalog when MISTRAL_API_KEY is absent', async () => {
    const { models, skipped } = await provider.listModels({})
    expect(models).toEqual([])
    expect(skipped).toBe('mistral: MISTRAL_API_KEY not set — skipped')
  })

  it('maps live rows and sends the bearer key', async () => {
    const original = globalThis.fetch
    const calls: Array<{ url: string; auth: string | null }> = []
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      calls.push({
        url: String(url),
        auth: new Headers(init?.headers).get('authorization'),
      })
      return Promise.resolve(
        new Response(
          JSON.stringify({
            object: 'list',
            data: [
              { id: 'mistral-small-latest', created: 1_700_000_000 },
              { id: 'mistral-embed' },
            ],
          }),
        ),
      )
    }) as typeof fetch
    try {
      const { models, skipped } = await provider.listModels({
        MISTRAL_API_KEY: 'mistral-test',
      })
      expect(skipped).toBeUndefined()
      expect(calls[0]?.url).toBe('https://api.mistral.ai/v1/models')
      expect(calls[0]?.auth).toBe('Bearer mistral-test')
      expect(models).toEqual([
        { rawId: 'mistral-small-latest', releasedAt: 1_700_000_000 },
        { rawId: 'mistral-embed', releasedAt: null },
      ])
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('mistral fetchSpec', () => {
  it('loads the public OpenAPI document without a key', async () => {
    const fixture = JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'Mistral AI API', version: '1.0.0' },
      paths: {
        '/v1/chat/completions': { post: { summary: 'Chat Completion' } },
      },
    })
    const original = globalThis.fetch
    const urls: Array<string> = []
    globalThis.fetch = ((url: string) => {
      urls.push(String(url))
      return Promise.resolve(new Response(fixture))
    }) as typeof fetch
    try {
      const fetched = await provider.fetchSpec({})
      expect(urls).toEqual(['https://docs.mistral.ai/openapi.yaml'])
      expect(fetched.outputStrategy).toBe('post-200')
      expect(fetched.specs).toHaveLength(1)
      expect(fetched.specs[0]?.info?.title).toBe('Mistral AI API')
      expect(fetched.sources[0]?.url).toBe(
        'https://docs.mistral.ai/openapi.yaml',
      )
      expect(fetched.sources[0]?.hash).toMatch(/^[0-9a-f]{64}$/)
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('mistral provider metadata', () => {
  it('exports the seed fields required for auto-registration', () => {
    expect(provider.id).toBe('mistral')
    expect(provider.displayName).toBe('Mistral')
    expect(provider.authEnvVar).toBe('MISTRAL_API_KEY')
    expect(provider.defaultDerivation).toBe('upstream-spec')
    expect(provider.specSourceUrl).toBe('https://docs.mistral.ai/openapi.yaml')
    expect(provider.modelsEndpoint).toBe('https://api.mistral.ai/v1/models')
  })
})
