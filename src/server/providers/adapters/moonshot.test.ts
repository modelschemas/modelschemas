import { describe, expect, it } from 'vitest'

import { provider } from './moonshot.ts'

const SPEC_URL = 'https://platform.kimi.com/docs/openapi.json'

const FIXTURE_SPEC = {
  openapi: '3.1.0',
  info: { title: 'Moonshot AI API', version: '1.0.0' },
  servers: [{ url: 'https://api.moonshot.cn' }],
  paths: {
    '/v1/chat/completions': { post: { summary: 'Create Chat Completion' } },
    '/v1/files': { post: { summary: 'Upload File' } },
  },
}

describe('moonshot adapter', () => {
  it('exports seed metadata for the China host', () => {
    expect(provider.id).toBe('moonshot')
    expect(provider.displayName).toBe('Moonshot')
    expect(provider.authEnvVar).toBe('MOONSHOT_API_KEY')
    expect(provider.defaultDerivation).toBe('upstream-spec')
    expect(provider.specSourceUrl).toBe(SPEC_URL)
    expect(provider.modelsEndpoint).toBe('https://api.moonshot.cn/v1/models')
  })

  it('classifies chat completions and drops platform paths', () => {
    expect(provider.classify('/v1/chat/completions', {})).toBe('chat')
    expect(provider.classify('/chat/completions', {})).toBe('chat')
    expect(provider.classify('/v1/files', {})).toBeNull()
    expect(provider.classify('/v1/batches', {})).toBeNull()
    expect(provider.classify('/v1/models', {})).toBeNull()
    expect(provider.classify('/v1/users/me/balance', {})).toBeNull()
    expect(
      provider.classify('/v1/tokenizers/estimate-token-count', {}),
    ).toBeNull()
  })

  it('skips listModels when the secret is absent', async () => {
    const result = await provider.listModels({})
    expect(result.models).toEqual([])
    expect(result.skipped).toBe('moonshot: MOONSHOT_API_KEY not set — skipped')
  })

  it('fetches the published spec without a key', async () => {
    const original = globalThis.fetch
    const urls: Array<string> = []
    globalThis.fetch = ((url: string) => {
      urls.push(String(url))
      return Promise.resolve(new Response(JSON.stringify(FIXTURE_SPEC)))
    }) as typeof fetch
    try {
      const fetched = await provider.fetchSpec({})
      expect(urls).toEqual([SPEC_URL])
      expect(fetched.outputStrategy).toBe('post-200')
      expect(fetched.sources).toHaveLength(1)
      expect(fetched.sources[0]?.url).toBe(SPEC_URL)
      expect(fetched.sources[0]?.hash).toMatch(/^[0-9a-f]{64}$/)
      expect(fetched.specs[0]?.info?.title).toBe('Moonshot AI API')
    } finally {
      globalThis.fetch = original
    }
  })
})
