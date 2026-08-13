import { describe, expect, it } from 'vitest'

import { classifyAndBundle } from '#/server/ingest/sync.ts'

import { provider } from './cerebras.ts'

const CEREBRAS_OPENAPI_URL =
  'https://inference-docs.cerebras.ai/api-reference/openapi.yaml'

const SPEC_FIXTURE = JSON.stringify({
  openapi: '3.1.0',
  info: { title: 'Cerebras Inference API', version: '1.0.0' },
  paths: {
    '/v1/chat/completions': {
      post: {
        summary: 'Create chat completion',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['model', 'messages'],
                properties: {
                  model: { type: 'string' },
                  messages: { type: 'array' },
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
    '/v1/models': { get: { summary: 'List models' } },
    '/v1/files': { post: { summary: 'Upload file' } },
    '/v1/batches': { post: { summary: 'Create batch' } },
  },
})

async function withMockedSpec<T>(run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = ((url: string) => {
    if (String(url) === CEREBRAS_OPENAPI_URL) {
      return Promise.resolve(new Response(SPEC_FIXTURE))
    }
    return Promise.reject(new Error(`unexpected fetch: ${String(url)}`))
  }) as typeof fetch
  try {
    return await run()
  } finally {
    globalThis.fetch = original
  }
}

describe('cerebras classify', () => {
  it('maps chat completions (and legacy completions) to chat', () => {
    expect(provider.classify('/v1/chat/completions', {})).toBe('chat')
    expect(provider.classify('/chat/completions', {})).toBe('chat')
    expect(provider.classify('/v1/completions', {})).toBe('chat')
  })

  it('drops models, files, batches, and dedicated-endpoint admin', () => {
    expect(provider.classify('/v1/models', {})).toBeNull()
    expect(provider.classify('/v1/files', {})).toBeNull()
    expect(provider.classify('/v1/batches', {})).toBeNull()
    expect(provider.classify('/v1/customer/endpoints', {})).toBeNull()
  })
})

describe('cerebras listModels', () => {
  it('skips when CEREBRAS_API_KEY is absent', async () => {
    const result = await provider.listModels({})
    expect(result.models).toEqual([])
    expect(result.skipped).toBe('cerebras: CEREBRAS_API_KEY not set — skipped')
  })
})

describe('cerebras fetchSpec', () => {
  it('fetches the published spec and bundles chat completions only', async () => {
    const fetched = await withMockedSpec(() => provider.fetchSpec({}))
    expect(fetched.specs).toHaveLength(1)
    expect(fetched.sources[0]?.url).toBe(CEREBRAS_OPENAPI_URL)
    expect(fetched.sources[0]?.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(fetched.outputStrategy).toBe('post-200')

    const { endpoints, warnings } = classifyAndBundle(provider, fetched)
    expect(warnings).toEqual([])
    expect(endpoints.map((e) => [e.dbId, e.activity])).toEqual([
      ['cerebras/v1/chat/completions', 'chat'],
    ])
  })
})
