import { describe, expect, it } from 'vitest'

import { OPENAI_OPENAPI_URL } from '../openai-compat.ts'
import { provider } from './dashscope.ts'

const OPENAI_FIXTURE = JSON.stringify({
  openapi: '3.1.0',
  info: { title: 'OpenAI API', version: '2.3.0' },
  servers: [{ url: 'https://api.openai.com/v1' }],
  paths: {
    '/chat/completions': { post: { operationId: 'createChatCompletion' } },
    '/embeddings': { post: { operationId: 'createEmbedding' } },
    '/images/generations': { post: { operationId: 'createImage' } },
    '/audio/speech': { post: { operationId: 'createSpeech' } },
    '/audio/transcriptions': { post: { operationId: 'createTranscription' } },
    '/files': { get: { operationId: 'listFiles' } },
  },
})

function withStubbedFetch<T>(
  handler: (url: string, init?: RequestInit) => Response,
  run: () => Promise<T>,
): Promise<{ result: T; calls: Array<{ url: string; auth: string | null }> }> {
  const original = globalThis.fetch
  const calls: Array<{ url: string; auth: string | null }> = []
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    calls.push({
      url: String(url),
      auth: new Headers(init?.headers).get('authorization'),
    })
    return Promise.resolve(handler(String(url), init))
  }) as typeof fetch
  return run()
    .then((result) => ({ result, calls }))
    .finally(() => {
      globalThis.fetch = original
    })
}

describe('dashscope adapter', () => {
  it('exports seed metadata for the OpenAI-compatible intl host', () => {
    expect(provider.id).toBe('dashscope')
    expect(provider.displayName).toBe('Alibaba Cloud Model Studio')
    expect(provider.authEnvVar).toBe('DASHSCOPE_API_KEY')
    expect(provider.defaultDerivation).toBe('generated')
    expect(provider.specSourceUrl).toMatch(/^https:\/\//)
    expect(provider.modelsEndpoint).toBe(
      'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models',
    )
  })

  it('classifies generation paths and drops platform ones', () => {
    expect(provider.classify('/chat/completions', {})).toBe('chat')
    expect(provider.classify('/v1/chat/completions', {})).toBe('chat')
    expect(provider.classify('/embeddings', {})).toBe('embeddings')
    expect(provider.classify('/images/generations', {})).toBe('image')
    expect(provider.classify('/audio/speech', {})).toBe('audio')
    expect(provider.classify('/audio/transcriptions', {})).toBe('audio')
    expect(provider.classify('/files', {})).toBeNull()
    expect(provider.classify('/v1/models', {})).toBeNull()
    expect(provider.classify('/fine_tuning/jobs', {})).toBeNull()
    expect(provider.classify('/batches', {})).toBeNull()
  })

  it('skips listModels when the key is absent', async () => {
    const { models, skipped } = await provider.listModels({})
    expect(models).toEqual([])
    expect(skipped).toBe('dashscope: DASHSCOPE_API_KEY not set — skipped')
  })

  it('fetches a filtered OpenAI spec without calling DashScope', async () => {
    const { result, calls } = await withStubbedFetch(
      (url) => {
        if (url === OPENAI_OPENAPI_URL) return new Response(OPENAI_FIXTURE)
        return new Response('not found', { status: 404 })
      },
      () => provider.fetchSpec({}),
    )

    expect(calls.map((c) => c.url)).toEqual([OPENAI_OPENAPI_URL])
    expect(result.outputStrategy).toBe('post-200')
    expect(result.sources[0]?.url).toBe(OPENAI_OPENAPI_URL)
    expect(result.sources[0]?.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(result.specs[0]?.info?.title).toBe('Alibaba Cloud Model Studio')
    expect(result.specs[0]?.servers).toEqual([
      { url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' },
    ])
    expect(Object.keys(result.specs[0]?.paths ?? {}).sort()).toEqual([
      '/audio/speech',
      '/audio/transcriptions',
      '/chat/completions',
      '/embeddings',
      '/images/generations',
    ])
    expect(result.specs[0]?.paths?.['/files']).toBeUndefined()
  })

  it('lists models with a bearer key against the intl host', async () => {
    const { result, calls } = await withStubbedFetch(
      () =>
        new Response(
          JSON.stringify({
            data: [{ id: 'qwen-plus', created: 1_716_430_652 }],
          }),
        ),
      () => provider.listModels({ DASHSCOPE_API_KEY: 'test-key' }),
    )
    expect(calls).toEqual([
      {
        url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models',
        auth: 'Bearer test-key',
      },
    ])
    expect(result.skipped).toBeUndefined()
    expect(result.models).toEqual([
      { rawId: 'qwen-plus', releasedAt: 1_716_430_652 },
    ])
  })
})
