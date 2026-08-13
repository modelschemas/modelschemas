import { afterEach, describe, expect, it } from 'vitest'

import { classifyAndBundle } from '#/server/ingest/sync.ts'
import { provider } from './runway.ts'
import type { OpenApiDocument } from '../types.ts'

const SPEC_URL =
  'https://raw.githubusercontent.com/runwayml/openapi/next/openapi.json'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('runway classify', () => {
  it('maps generation POSTs to video, image, and audio', () => {
    expect(provider.classify('/v1/text_to_video', {})).toBe('video')
    expect(provider.classify('/v1/image_to_video', {})).toBe('video')
    expect(provider.classify('/v1/video_to_video', {})).toBe('video')
    expect(provider.classify('/v1/video_upscale', {})).toBe('video')
    expect(provider.classify('/v1/character_performance', {})).toBe('video')
    expect(provider.classify('/v1/generate/video', {})).toBe('video')
    expect(provider.classify('/v1/avatar_videos', {})).toBe('video')
    expect(provider.classify('/v1/recipes/product_ad', {})).toBe('video')

    expect(provider.classify('/v1/text_to_image', {})).toBe('image')
    expect(provider.classify('/v1/image_upscale', {})).toBe('image')
    expect(provider.classify('/v1/generate/image', {})).toBe('image')
    expect(provider.classify('/v1/recipes/ad_localization', {})).toBe('image')

    expect(provider.classify('/v1/text_to_speech', {})).toBe('audio')
    expect(provider.classify('/v1/sound_effect', {})).toBe('audio')
    expect(provider.classify('/v1/generate/audio', {})).toBe('audio')
  })

  it('drops task management and other platform surfaces', () => {
    expect(provider.classify('/v1/tasks/{id}', {})).toBeNull()
    expect(provider.classify('/v1/organization', {})).toBeNull()
    expect(provider.classify('/v1/uploads', {})).toBeNull()
    expect(provider.classify('/v1/avatars', {})).toBeNull()
    expect(provider.classify('/v1/routers', {})).toBeNull()
    expect(provider.classify('/v1/voices', {})).toBeNull()
    expect(provider.classify('/v1/workflows/{id}', {})).toBeNull()
    expect(provider.classify('/v1/documents', {})).toBeNull()
  })
})

describe('runway listModels', () => {
  it('skips with an empty catalog when the secret is absent', async () => {
    const result = await provider.listModels({})
    expect(result.models).toEqual([])
    expect(result.skipped).toMatch(/RUNWAY_API_KEY not set/)
  })
})

describe('runway fetchSpec', () => {
  it('loads the public Stainless document without a key', async () => {
    const spec: OpenApiDocument = {
      openapi: '3.1.0',
      info: { title: 'RunwayML API', version: '2024-11-06' },
      paths: {
        '/v1/text_to_video': {
          post: {
            summary: 'Text to video',
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { promptText: { type: 'string' } },
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
        '/v1/tasks/{id}': {
          get: { summary: 'Get task detail' },
          delete: { summary: 'Cancel or delete a task' },
        },
        '/v1/organization': {
          get: { summary: 'Get organization information' },
        },
      },
    }
    const urls: Array<string> = []
    globalThis.fetch = ((url: string) => {
      urls.push(String(url))
      return Promise.resolve(new Response(JSON.stringify(spec)))
    }) as typeof fetch

    const fetched = await provider.fetchSpec({})
    expect(urls).toEqual([SPEC_URL])
    expect(fetched.outputStrategy).toBe('post-200')
    expect(fetched.specs).toHaveLength(1)
    expect(fetched.sources[0]?.url).toBe(SPEC_URL)
    expect(fetched.sources[0]?.hash).toMatch(/^[0-9a-f]{64}$/)

    const { endpoints, warnings } = classifyAndBundle(provider, fetched)
    expect(warnings).toEqual([])
    expect(endpoints.map((e) => [e.path, e.activity])).toEqual([
      ['/v1/text_to_video', 'video'],
    ])
  })
})
