import { afterEach, describe, expect, it } from 'vitest'

import { provider } from './perplexity.ts'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('perplexity provider', () => {
  it('exports seed metadata for the isolation loader', () => {
    expect(provider.id).toBe('perplexity')
    expect(provider.displayName).toBe('Perplexity')
    expect(provider.authEnvVar).toBe('PERPLEXITY_API_KEY')
    expect(provider.defaultDerivation).toBe('upstream-spec')
    expect(provider.specSourceUrl).toBe(
      'https://docs.perplexity.ai/openapi.json',
    )
    expect(provider.modelsEndpoint).toBe('https://api.perplexity.ai/v1/models')
  })
})

describe('perplexity classify', () => {
  it('maps generation paths and drops search, async, and platform', () => {
    expect(provider.classify('/v1/sonar', {})).toBe('chat')
    expect(provider.classify('/v1/agent', {})).toBe('chat')
    expect(provider.classify('/v1/embeddings', {})).toBe('embeddings')
    expect(provider.classify('/v1/contextualizedembeddings', {})).toBe(
      'embeddings',
    )
    expect(provider.classify('/search', {})).toBeNull()
    expect(provider.classify('/v1/async/sonar', {})).toBeNull()
    expect(provider.classify('/v1/models', {})).toBeNull()
    expect(provider.classify('/v1/agent/{id}/cancel', {})).toBeNull()
    expect(provider.classify('/v1/analytics/computer/usage', {})).toBeNull()
  })
})

describe('perplexity listModels', () => {
  it('skips when the secret is absent', async () => {
    const result = await provider.listModels({})
    expect(result.skipped).toBe(
      'perplexity: PERPLEXITY_API_KEY not set — skipped',
    )
    expect(result.models).toEqual([])
  })

  it('parses the OpenAI-style model list when a key is set', async () => {
    const urls: Array<string> = []
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      urls.push(String(url))
      expect(
        new Headers(init?.headers).get('Authorization')?.startsWith('Bearer '),
      ).toBe(true)
      return Promise.resolve(
        Response.json({
          object: 'list',
          data: [
            { id: 'sonar', created: 1 },
            { id: 'perplexity/sonar', created: 2 },
          ],
        }),
      )
    }) as typeof fetch

    const result = await provider.listModels({
      PERPLEXITY_API_KEY: 'test-key',
    })
    expect(urls).toEqual(['https://api.perplexity.ai/v1/models'])
    expect(result.skipped).toBeUndefined()
    expect(result.models).toEqual([
      { rawId: 'sonar', releasedAt: 1 },
      { rawId: 'perplexity/sonar', releasedAt: 2 },
    ])
  })
})

describe('perplexity fetchSpec', () => {
  it('loads the published OpenAPI document without a key', async () => {
    const spec = {
      openapi: '3.1.0',
      info: { title: 'Perplexity AI API' },
      paths: { '/v1/sonar': { post: { summary: 'Create Chat Completion' } } },
    }
    globalThis.fetch = ((url: string) => {
      expect(String(url)).toBe('https://docs.perplexity.ai/openapi.json')
      return Promise.resolve(new Response(JSON.stringify(spec)))
    }) as typeof fetch

    const fetched = await provider.fetchSpec({})
    expect(fetched.specs).toHaveLength(1)
    expect(fetched.specs[0]?.info?.title).toBe('Perplexity AI API')
    expect(fetched.sources[0]?.url).toBe(
      'https://docs.perplexity.ai/openapi.json',
    )
    expect(fetched.sources[0]?.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(fetched.outputStrategy).toBe('post-200')
  })
})
