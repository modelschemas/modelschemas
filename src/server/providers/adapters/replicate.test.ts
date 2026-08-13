import { describe, expect, it } from 'vitest'

import { classifyAndBundle } from '#/server/ingest/sync.ts'
import type { OpenApiDocument } from '../types.ts'
import { provider } from './replicate.ts'

describe('replicate classify', () => {
  it('maps generation creates onto chat, image, video, and audio', () => {
    expect(
      provider.classify(
        '/models/meta/meta-llama-3-70b-instruct/predictions',
        {},
      ),
    ).toBe('chat')
    expect(
      provider.classify(
        '/v1/models/meta/llama-3.1-405b-instruct/predictions',
        {},
      ),
    ).toBe('chat')
    expect(provider.classify('/predictions', {})).toBe('image')
    expect(provider.classify('/v1/predictions', {})).toBe('image')
    expect(
      provider.classify(
        '/models/black-forest-labs/flux-schnell/predictions',
        {},
      ),
    ).toBe('image')
    expect(provider.classify('/models/minimax/video-01/predictions', {})).toBe(
      'video',
    )
    expect(provider.classify('/models/openai/whisper/predictions', {})).toBe(
      'audio',
    )
  })

  it('drops account, collections, hardware, trainings, and cancel', () => {
    expect(provider.classify('/account', {})).toBeNull()
    expect(provider.classify('/collections', {})).toBeNull()
    expect(provider.classify('/hardware', {})).toBeNull()
    expect(provider.classify('/models', {})).toBeNull()
    expect(
      provider.classify(
        '/models/{model_owner}/{model_name}/versions/{version_id}/trainings',
        {},
      ),
    ).toBeNull()
    expect(
      provider.classify('/predictions/{prediction_id}/cancel', {}),
    ).toBeNull()
    expect(
      provider.classify(
        '/deployments/{deployment_owner}/{deployment_name}/predictions',
        {},
      ),
    ).toBeNull()
  })
})

describe('replicate listModels', () => {
  it('skips when REPLICATE_API_TOKEN is absent', async () => {
    const result = await provider.listModels({})
    expect(result.skipped).toBe(
      'replicate: REPLICATE_API_TOKEN not set — skipped',
    )
    expect(result.models).toEqual([])
  })

  it('pages GET /v1/models and maps owner/name', async () => {
    const pages: Record<string, unknown> = {
      'https://api.replicate.com/v1/models': {
        next: 'https://api.replicate.com/v1/models?cursor=p2',
        results: [
          {
            owner: 'black-forest-labs',
            name: 'flux-schnell',
            description: 'Fast text-to-image',
            created_at: '2024-08-01T00:00:00Z',
            is_official: true,
          },
        ],
      },
      'https://api.replicate.com/v1/models?cursor=p2': {
        next: null,
        results: [
          {
            owner: 'openai',
            name: 'whisper',
            description: 'Speech-to-text',
            latest_version: { created_at: '2023-01-02T00:00:00Z' },
          },
        ],
      },
    }
    const original = globalThis.fetch
    const calls: Array<{ url: string; auth: string | null }> = []
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      const href = String(url)
      calls.push({
        url: href,
        auth: new Headers(init?.headers).get('authorization'),
      })
      const body = pages[href]
      return Promise.resolve(
        body
          ? new Response(JSON.stringify(body))
          : new Response('not found', { status: 404 }),
      )
    }) as typeof fetch
    try {
      const result = await provider.listModels({
        REPLICATE_API_TOKEN: 'tok-test',
      })
      expect(calls.map((c) => c.url)).toEqual([
        'https://api.replicate.com/v1/models',
        'https://api.replicate.com/v1/models?cursor=p2',
      ])
      expect(calls[0]?.auth).toBe('Bearer tok-test')
      expect(result.skipped).toBeUndefined()
      expect(result.models.map((m) => [m.rawId, m.activity])).toEqual([
        ['black-forest-labs/flux-schnell', 'image'],
        ['openai/whisper', 'audio'],
      ])
      expect(result.models[0]?.releasedAt).toBe(
        Date.parse('2024-08-01T00:00:00Z') / 1000,
      )
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('replicate fetchSpec', () => {
  it('loads the public OpenAPI document', async () => {
    const spec: OpenApiDocument = {
      openapi: '3.1.0',
      paths: {
        '/predictions': {
          post: {
            summary: 'Create a prediction',
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      version: { type: 'string' },
                      input: { type: 'object' },
                    },
                  },
                },
              },
            },
            responses: {
              '200': {
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: { id: { type: 'string' } },
                    },
                  },
                },
              },
            },
          },
        },
        '/account': { get: { summary: 'Get the current account' } },
      },
    }
    const original = globalThis.fetch
    const urls: Array<string> = []
    globalThis.fetch = ((url: string) => {
      urls.push(String(url))
      return Promise.resolve(new Response(JSON.stringify(spec)))
    }) as typeof fetch
    try {
      const fetched = await provider.fetchSpec({})
      expect(urls).toEqual(['https://api.replicate.com/openapi.json'])
      expect(fetched.outputStrategy).toBe('post-200')
      expect(fetched.skipped).toBeUndefined()
      expect(fetched.sources[0]?.url).toBe(
        'https://api.replicate.com/openapi.json',
      )
      expect(fetched.sources[0]?.hash).toMatch(/^[0-9a-f]{64}$/)

      const { endpoints, warnings } = classifyAndBundle(provider, fetched)
      expect(warnings).toEqual([])
      expect(endpoints.map((e) => [e.dbId, e.activity])).toEqual([
        ['replicate/predictions', 'image'],
      ])
      expect(endpoints[0]?.derivation).toBe('upstream-spec')
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('replicate seed metadata', () => {
  it('exports the adapter contract', () => {
    expect(provider.id).toBe('replicate')
    expect(provider.displayName).toBe('Replicate')
    expect(provider.authEnvVar).toBe('REPLICATE_API_TOKEN')
    expect(provider.defaultDerivation).toBe('upstream-spec')
    expect(provider.specSourceUrl).toBe(
      'https://api.replicate.com/openapi.json',
    )
    expect(provider.modelsEndpoint).toBe('https://api.replicate.com/v1/models')
  })
})
