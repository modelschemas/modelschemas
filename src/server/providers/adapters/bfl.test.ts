import { describe, expect, it } from 'vitest'

import { provider } from './bfl.ts'

describe('bfl adapter metadata', () => {
  it('exports a seeded upstream-spec adapter', () => {
    expect(provider.id).toBe('bfl')
    expect(provider.displayName).toBe('Black Forest Labs')
    expect(provider.authEnvVar).toBe('BFL_API_KEY')
    expect(provider.defaultDerivation).toBe('upstream-spec')
    expect(provider.specSourceUrl).toBe('https://api.bfl.ai/openapi.json')
    expect(provider.modelsEndpoint).toBe('https://api.bfl.ai/v1/models')
  })
})

describe('bfl classify', () => {
  const models = { tags: ['Models'] }
  const utility = { tags: ['Utility'] }

  it('maps FLUX generation POSTs and drops utility/admin', () => {
    expect(provider.classify('/v1/flux-2-pro', models)).toBe('image')
    expect(provider.classify('/v1/flux-2-flex', models)).toBe('image')
    expect(provider.classify('/v1/flux-tools/vto-v1', models)).toBe('image')
    expect(provider.classify('/v1/flux-kontext-pro', models)).toBe('image')
    expect(provider.classify('/v1/flux-3-video', models)).toBe('video')
    expect(provider.classify('/v1/delete_finetune', utility)).toBeNull()
    expect(provider.classify('/v1/get_result', utility)).toBeNull()
    expect(provider.classify('/v1/credits', {})).toBeNull()
    expect(provider.classify('/v1/my_finetunes', utility)).toBeNull()
  })
})

describe('bfl listModels', () => {
  it('skips when BFL_API_KEY is absent', async () => {
    const result = await provider.listModels({})
    expect(result.models).toEqual([])
    expect(result.skipped).toBe('bfl: BFL_API_KEY not set — skipped')
  })

  it('falls back to path-derived ids when /v1/models is missing', async () => {
    const original = globalThis.fetch
    const urls: Array<string> = []
    globalThis.fetch = ((url: string) => {
      urls.push(String(url))
      return Promise.resolve(new Response('not found', { status: 404 }))
    }) as typeof fetch
    try {
      const result = await provider.listModels({ BFL_API_KEY: 'test-key' })
      expect(urls).toEqual(['https://api.bfl.ai/v1/models'])
      expect(result.skipped).toBeUndefined()
      expect(result.models.map((m) => m.rawId)).toEqual(
        expect.arrayContaining(['flux-2-pro', 'flux-3-video']),
      )
      expect(
        result.models.find((m) => m.rawId === 'flux-3-video')?.activity,
      ).toBe('video')
    } finally {
      globalThis.fetch = original
    }
  })

  it('uses a live listing when /v1/models returns data', async () => {
    const original = globalThis.fetch
    globalThis.fetch = ((url: string) => {
      expect(String(url)).toBe('https://api.bfl.ai/v1/models')
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [{ id: 'flux-2-pro', created: 1_700_000_000 }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
    }) as typeof fetch
    try {
      const result = await provider.listModels({ BFL_API_KEY: 'test-key' })
      expect(result).toEqual({
        models: [{ rawId: 'flux-2-pro', releasedAt: 1_700_000_000 }],
      })
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('bfl fetchSpec', () => {
  it('loads the public OpenAPI document without a key', async () => {
    const original = globalThis.fetch
    const spec = {
      openapi: '3.1.0',
      info: { title: 'BFL API', version: '0.0.1' },
      paths: { '/v1/flux-2-pro': { post: { tags: ['Models'] } } },
    }
    const urls: Array<string> = []
    globalThis.fetch = ((url: string) => {
      urls.push(String(url))
      return Promise.resolve(
        new Response(JSON.stringify(spec), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
    }) as typeof fetch
    try {
      const fetched = await provider.fetchSpec({})
      expect(urls).toEqual(['https://api.bfl.ai/openapi.json'])
      expect(fetched.specs).toHaveLength(1)
      expect(fetched.specs[0]?.info?.title).toBe('BFL API')
      expect(fetched.sources[0]?.url).toBe('https://api.bfl.ai/openapi.json')
      expect(fetched.sources[0]?.hash).toMatch(/^[0-9a-f]{64}$/)
      expect(fetched.outputStrategy).toBe('post-200')
    } finally {
      globalThis.fetch = original
    }
  })
})
