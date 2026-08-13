import { describe, expect, it } from 'vitest'

import { provider } from './fireworks.ts'

const SPEC_URL = 'https://docs.fireworks.ai/text-completion.openapi.yaml'
const MODELS_URL = 'https://api.fireworks.ai/inference/v1/models'

const SPEC_FIXTURE = JSON.stringify({
  openapi: '3.1.0',
  info: { title: 'Fireworks Text Completion API', version: '0.1.0' },
  paths: {
    '/v1/chat/completions': {
      post: { summary: 'Create Chat Completion' },
    },
    '/v1/completions': {
      post: { summary: 'Create Completion' },
    },
  },
})

describe('fireworks provider', () => {
  it('exports the fireworks adapter contract', () => {
    expect(provider.id).toBe('fireworks')
    expect(provider.displayName).toBe('Fireworks AI')
    expect(provider.authEnvVar).toBe('FIREWORKS_API_KEY')
    expect(provider.specSourceUrl).toBe(SPEC_URL)
    expect(provider.modelsEndpoint).toBe(MODELS_URL)
    expect(provider.defaultDerivation).toBe('upstream-spec')
  })
})

describe('fireworks classify', () => {
  it('maps generation endpoints and drops platform paths', () => {
    expect(provider.classify('/v1/chat/completions', {})).toBe('chat')
    expect(provider.classify('/chat/completions', {})).toBe('chat')
    expect(provider.classify('/inference/v1/chat/completions', {})).toBe('chat')
    expect(provider.classify('/v1/completions', {})).toBe('chat')
    expect(provider.classify('/v1/responses', {})).toBe('chat')
    expect(provider.classify('/v1/messages', {})).toBe('chat')
    expect(provider.classify('/v1/embeddings', {})).toBe('embeddings')
    expect(provider.classify('/v1/accounts/acme/models', {})).toBeNull()
    expect(
      provider.classify('/v1/accounts/acme/batchInferenceJobs', {}),
    ).toBeNull()
    expect(provider.classify('/v1/rerank', {})).toBeNull()
    expect(provider.classify('/inference/v1/models', {})).toBeNull()
    expect(provider.classify('/files', {})).toBeNull()
  })
})

describe('fireworks listModels', () => {
  it('skips when FIREWORKS_API_KEY is absent', async () => {
    const result = await provider.listModels({})
    expect(result.skipped).toBe(
      'fireworks: FIREWORKS_API_KEY not set — skipped',
    )
    expect(result.models).toEqual([])
  })
})

describe('fireworks fetchSpec', () => {
  it('fetches the official text-completion document', async () => {
    const original = globalThis.fetch
    const urls: Array<string> = []
    globalThis.fetch = ((url: string) => {
      urls.push(String(url))
      return Promise.resolve(new Response(SPEC_FIXTURE))
    }) as typeof fetch
    try {
      const result = await provider.fetchSpec({})
      expect(urls).toEqual([SPEC_URL])
      expect(result.specs).toHaveLength(1)
      expect(result.specs[0]?.paths?.['/v1/chat/completions']).toBeDefined()
      expect(result.sources[0]?.url).toBe(SPEC_URL)
      expect(result.sources[0]?.hash).toMatch(/^[0-9a-f]{64}$/)
      expect(result.sources).toHaveLength(1)
      expect(result.outputStrategy).toBe('post-200')
    } finally {
      globalThis.fetch = original
    }
  })
})
