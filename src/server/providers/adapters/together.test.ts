import { describe, expect, it } from 'vitest'

import { classifyAndBundle } from '#/server/ingest/sync.ts'

import { provider } from './together.ts'

const SPEC_YAML = `openapi: 3.1.0
info:
  title: Together APIs
paths:
  /chat/completions:
    post:
      summary: Create chat completion
      requestBody:
        content:
          application/json:
            schema:
              type: object
              required: [model, messages]
              properties:
                model: { type: string }
                messages: { type: array }
      responses:
        "200":
          content:
            application/json:
              schema:
                type: object
                properties:
                  id: { type: string }
  /embeddings:
    post:
      summary: Create embedding
      requestBody:
        content:
          application/json:
            schema:
              type: object
              required: [model, input]
              properties:
                model: { type: string }
                input: { type: string }
      responses:
        "200":
          content:
            application/json:
              schema:
                type: object
  /images/generations:
    post:
      summary: Create image
      requestBody:
        content:
          application/json:
            schema:
              type: object
              required: [model, prompt]
              properties:
                model: { type: string }
                prompt: { type: string }
      responses:
        "200":
          content:
            application/json:
              schema:
                type: object
  /videos:
    post:
      summary: Create video
      requestBody:
        content:
          application/json:
            schema:
              type: object
              required: [model]
              properties:
                model: { type: string }
      responses:
        "200":
          content:
            application/json:
              schema:
                type: object
  /audio/speech:
    post:
      summary: Create audio
      requestBody:
        content:
          application/json:
            schema:
              type: object
              required: [model, input]
              properties:
                model: { type: string }
                input: { type: string }
      responses:
        "200":
          content:
            application/json:
              schema:
                type: object
  /files:
    post:
      summary: Upload file
      requestBody:
        content:
          application/json:
            schema:
              type: object
      responses:
        "200":
          content:
            application/json:
              schema:
                type: object
`

describe('together classify', () => {
  it('maps generation paths to activities', () => {
    expect(provider.classify('/chat/completions', {})).toBe('chat')
    expect(provider.classify('/completions', {})).toBe('chat')
    expect(provider.classify('/v1/chat/completions', {})).toBe('chat')
    expect(provider.classify('/embeddings', {})).toBe('embeddings')
    expect(provider.classify('/images/generations', {})).toBe('image')
    expect(provider.classify('/videos', {})).toBe('video')
    expect(provider.classify('/audio/speech', {})).toBe('audio')
    expect(provider.classify('/audio/transcriptions', {})).toBe('audio')
    expect(provider.classify('/audio/translations', {})).toBe('audio')
  })

  it('drops files, fine-tune, rerank, batches, and endpoint admin', () => {
    expect(provider.classify('/files', {})).toBeNull()
    expect(provider.classify('/fine-tunes', {})).toBeNull()
    expect(provider.classify('/rerank', {})).toBeNull()
    expect(provider.classify('/batches', {})).toBeNull()
    expect(provider.classify('/endpoints', {})).toBeNull()
    expect(provider.classify('/projects/{projectId}/endpoints', {})).toBeNull()
    expect(provider.classify('/models', {})).toBeNull()
    expect(provider.classify('/videos/{id}', {})).toBeNull()
  })
})

describe('together listModels', () => {
  it('skips when TOGETHER_API_KEY is absent', async () => {
    const result = await provider.listModels({})
    expect(result.models).toEqual([])
    expect(result.skipped).toBe('together: TOGETHER_API_KEY not set — skipped')
  })

  it('parses Together’s bare-array catalog', async () => {
    const original = globalThis.fetch
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.together.xyz/v1/models')
      const headers = new Headers(init?.headers)
      expect(headers.get('Authorization')).toBe('Bearer test-key')
      return Promise.resolve(
        new Response(
          JSON.stringify([
            {
              id: 'Qwen/Qwen3.5-9B',
              display_name: 'Qwen 3.5 9B',
              created: 1692896905,
              type: 'chat',
              context_length: 32768,
            },
            { id: 'BAAI/bge-large-en-v1.5', type: 'embedding' },
            { id: 'org/reranker', type: 'rerank' },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
    }) as typeof fetch
    try {
      const result = await provider.listModels({ TOGETHER_API_KEY: 'test-key' })
      expect(result.skipped).toBeUndefined()
      expect(result.models).toEqual([
        {
          rawId: 'Qwen/Qwen3.5-9B',
          displayName: 'Qwen 3.5 9B',
          activity: 'chat',
          contextWindow: 32768,
          releasedAt: 1692896905,
        },
        {
          rawId: 'BAAI/bge-large-en-v1.5',
          displayName: null,
          activity: 'embeddings',
          contextWindow: null,
          releasedAt: null,
        },
        {
          rawId: 'org/reranker',
          displayName: null,
          activity: null,
          contextWindow: null,
          releasedAt: null,
        },
      ])
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('together fetchSpec', () => {
  it('loads the published yaml and classifies generation POSTs', async () => {
    const original = globalThis.fetch
    globalThis.fetch = ((url: string) => {
      expect(String(url)).toBe('https://docs.together.ai/openapi.yaml')
      return Promise.resolve(new Response(SPEC_YAML, { status: 200 }))
    }) as typeof fetch
    try {
      const fetched = await provider.fetchSpec({})
      expect(fetched.outputStrategy).toBe('post-200')
      expect(fetched.sources[0]?.url).toBe(
        'https://docs.together.ai/openapi.yaml',
      )
      expect(fetched.sources[0]?.hash).toMatch(/^[0-9a-f]{64}$/)

      const { endpoints, warnings } = classifyAndBundle(provider, fetched)
      expect(warnings).toEqual([])
      expect(
        endpoints.map((endpoint) => [endpoint.dbId, endpoint.activity]).sort(),
      ).toEqual([
        ['together/audio/speech', 'audio'],
        ['together/chat/completions', 'chat'],
        ['together/embeddings', 'embeddings'],
        ['together/images/generations', 'image'],
        ['together/videos', 'video'],
      ])
      expect(
        endpoints.every((endpoint) => endpoint.derivation === 'upstream-spec'),
      ).toBe(true)
    } finally {
      globalThis.fetch = original
    }
  })
})
