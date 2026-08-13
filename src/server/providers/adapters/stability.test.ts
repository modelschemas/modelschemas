import { describe, expect, it } from 'vitest'

import { findDanglingRefs } from '#/server/ingest/bundle.ts'
import { classifyAndBundle } from '#/server/ingest/sync.ts'
import type { OpenApiDocument } from '../types.ts'
import { provider } from './stability.ts'

const SPEC_URL = 'https://api.stability.ai/v2alpha/openapi'
const ENGINES_URL = 'https://api.stability.ai/v1/engines/list'

const FIXTURE_SPEC: OpenApiDocument = {
  openapi: '3.0.1',
  info: { title: 'StabilityAI REST API', version: 'v2beta' },
  servers: [{ url: 'https://api.stability.ai' }],
  paths: {
    '/v2beta/stable-image/generate/ultra': {
      post: {
        summary: 'Stable Image Ultra',
        requestBody: {
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['prompt'],
                properties: {
                  prompt: { type: 'string' },
                  output_format: {
                    type: 'string',
                    enum: ['jpeg', 'png', 'webp'],
                  },
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
                  properties: {
                    image: { type: 'string' },
                    finish_reason: { type: 'string' },
                    seed: { type: 'number' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/v2beta/audio/stable-audio-2/text-to-audio': {
      post: {
        summary: 'Text-to-Audio',
        requestBody: {
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['prompt'],
                properties: { prompt: { type: 'string' } },
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
                  properties: { audio: { type: 'string' } },
                },
              },
            },
          },
        },
      },
    },
    '/v2beta/3d/stable-fast-3d': {
      post: {
        summary: 'Stable Fast 3D',
        requestBody: {
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                properties: { image: { type: 'string' } },
              },
            },
          },
        },
        responses: { '200': { description: 'model/gltf-binary' } },
      },
    },
  },
}

async function withFetch<T>(
  handler: (url: string, init?: RequestInit) => Response,
  run: () => Promise<T>,
): Promise<{ result: T; urls: Array<string> }> {
  const original = globalThis.fetch
  const urls: Array<string> = []
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const href = String(input)
    urls.push(href)
    return Promise.resolve(handler(href, init))
  }
  try {
    return { result: await run(), urls }
  } finally {
    globalThis.fetch = original
  }
}

describe('stability classify', () => {
  it('maps image and audio generation paths and drops platform ones', () => {
    expect(provider.classify('/v2beta/stable-image/generate/ultra', {})).toBe(
      'image',
    )
    expect(provider.classify('/v2beta/stable-image/upscale/fast', {})).toBe(
      'image',
    )
    expect(provider.classify('/v2beta/stable-image/edit/inpaint', {})).toBe(
      'image',
    )
    expect(
      provider.classify('/v2alpha/generation/stable-image/upscale', {}),
    ).toBe('image')
    expect(
      provider.classify('/v2beta/audio/stable-audio-2/text-to-audio', {}),
    ).toBe('audio')
    expect(provider.classify('/v2beta/results/{id}', {})).toBeNull()
    expect(
      provider.classify(
        '/v2beta/stable-image/upscale/creative/result/{id}',
        {},
      ),
    ).toBeNull()
    expect(provider.classify('/v2beta/audio/results/{id}', {})).toBeNull()
    expect(provider.classify('/v2beta/3d/stable-fast-3d', {})).toBeNull()
    expect(provider.classify('/v1/user/account', {})).toBeNull()
    expect(provider.classify('/v1/engines/list', {})).toBeNull()
  })
})

describe('stability listModels', () => {
  it('skips with an empty catalog when the secret is absent', async () => {
    const result = await provider.listModels({})
    expect(result.models).toEqual([])
    expect(result.skipped).toBe(
      'stability: STABILITY_API_KEY not set — skipped',
    )
  })

  it('maps engines/list entries without calling a live host', async () => {
    const { result, urls } = await withFetch(
      (url) => {
        expect(url).toBe(ENGINES_URL)
        return new Response(
          JSON.stringify([
            {
              id: 'stable-diffusion-xl-1024-v1-0',
              name: 'Stable Diffusion XL 1.0',
              type: 'PICTURE',
            },
            { id: 'stable-audio', name: 'Stable Audio', type: 'AUDIO' },
          ]),
        )
      },
      () => provider.listModels({ STABILITY_API_KEY: 'test-key' }),
    )
    expect(urls).toEqual([ENGINES_URL])
    expect(result.skipped).toBeUndefined()
    expect(result.models).toEqual([
      {
        rawId: 'stable-diffusion-xl-1024-v1-0',
        displayName: 'Stable Diffusion XL 1.0',
        activity: 'image',
      },
      {
        rawId: 'stable-audio',
        displayName: 'Stable Audio',
        activity: 'audio',
      },
    ])
  })
})

describe('stability fetchSpec', () => {
  it('loads the public spec keylessly and bundles generation POSTs', async () => {
    const { result: fetched, urls } = await withFetch(
      (url) => {
        expect(url).toBe(SPEC_URL)
        return new Response(JSON.stringify(FIXTURE_SPEC))
      },
      () => provider.fetchSpec({}),
    )
    expect(urls).toEqual([SPEC_URL])
    expect(fetched.outputStrategy).toBe('post-200')
    expect(fetched.sources[0]?.url).toBe(SPEC_URL)
    expect(fetched.sources[0]?.hash).toMatch(/^[0-9a-f]{64}$/)

    const { endpoints, warnings } = classifyAndBundle(provider, fetched)
    expect(warnings).toEqual([])
    expect(endpoints.map((e) => [e.dbId, e.activity]).sort()).toEqual([
      ['stability/v2beta/audio/stable-audio-2/text-to-audio', 'audio'],
      ['stability/v2beta/stable-image/generate/ultra', 'image'],
    ])
    for (const endpoint of endpoints) {
      expect(endpoint.input, endpoint.dbId).toBeDefined()
      expect(endpoint.output, endpoint.dbId).toBeDefined()
      if (endpoint.input) expect(findDanglingRefs(endpoint.input)).toEqual([])
      if (endpoint.output) expect(findDanglingRefs(endpoint.output)).toEqual([])
    }
  })
})

describe('stability seed metadata', () => {
  it('exports the adapter contract fields', () => {
    expect(provider.id).toBe('stability')
    expect(provider.displayName).toBe('Stability AI')
    expect(provider.authEnvVar).toBe('STABILITY_API_KEY')
    expect(provider.specSourceUrl).toBe(SPEC_URL)
    expect(provider.modelsEndpoint).toBe(ENGINES_URL)
    expect(provider.defaultDerivation).toBe('upstream-spec')
  })
})
