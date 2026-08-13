import { describe, expect, it } from 'vitest'

import { provider } from './cohere.ts'

describe('cohere classify', () => {
  it('maps chat, embed, and audio generation paths', () => {
    expect(provider.classify('/v1/chat', {})).toBe('chat')
    expect(provider.classify('/v2/chat', {})).toBe('chat')
    expect(provider.classify('/v1/generate', {})).toBe('chat')
    expect(provider.classify('/v1/embed', {})).toBe('embeddings')
    expect(provider.classify('/v2/embed', {})).toBe('embeddings')
    expect(provider.classify('/v2/audio/transcriptions', {})).toBe('audio')
  })

  it('drops rerank, classify, datasets, finetune, and admin', () => {
    expect(provider.classify('/v1/rerank', {})).toBeNull()
    expect(provider.classify('/v2/rerank', {})).toBeNull()
    expect(provider.classify('/v1/classify', {})).toBeNull()
    expect(provider.classify('/v1/datasets', {})).toBeNull()
    expect(provider.classify('/v1/finetuning/finetuned-models', {})).toBeNull()
    expect(provider.classify('/v2/batches', {})).toBeNull()
    expect(provider.classify('/v1/models', {})).toBeNull()
  })
})

describe('cohere listModels', () => {
  it('skips when COHERE_API_KEY is absent', async () => {
    const result = await provider.listModels({})
    expect(result.models).toEqual([])
    expect(result.skipped).toBe('cohere: COHERE_API_KEY not set — skipped')
  })

  it('maps models[] pages (not OpenAI data[])', async () => {
    const original = globalThis.fetch
    globalThis.fetch = ((url: string) => {
      const href = String(url)
      if (href.includes('page_token=page-2')) {
        return Promise.resolve(
          Response.json({
            models: [
              {
                name: 'embed-v4.0',
                endpoints: ['embed'],
                context_length: 128000,
              },
            ],
          }),
        )
      }
      return Promise.resolve(
        Response.json({
          models: [
            {
              name: 'command-a-03-2025',
              endpoints: ['chat'],
              context_length: 256000,
            },
          ],
          next_page_token: 'page-2',
        }),
      )
    }) as typeof fetch
    try {
      const result = await provider.listModels({
        COHERE_API_KEY: 'test-key',
      })
      expect(result.skipped).toBeUndefined()
      expect(result.models).toEqual([
        {
          rawId: 'command-a-03-2025',
          contextWindow: 256000,
          activity: 'chat',
          deprecated: false,
        },
        {
          rawId: 'embed-v4.0',
          contextWindow: 128000,
          activity: 'embeddings',
          deprecated: false,
        },
      ])
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('cohere fetchSpec', () => {
  it('loads the public YAML without a key', async () => {
    const original = globalThis.fetch
    const specYaml = 'openapi: "3.1.0"\ninfo:\n  title: Cohere\npaths: {}\n'
    globalThis.fetch = ((url: string) => {
      expect(String(url)).toBe(
        'https://raw.githubusercontent.com/cohere-ai/cohere-developer-experience/main/cohere-openapi.yaml',
      )
      return Promise.resolve(new Response(specYaml))
    }) as typeof fetch
    try {
      const result = await provider.fetchSpec({})
      expect(result.outputStrategy).toBe('post-200')
      expect(result.specs).toHaveLength(1)
      expect(result.specs[0]?.info?.title).toBe('Cohere')
      expect(result.sources[0]?.url).toBe(
        'https://raw.githubusercontent.com/cohere-ai/cohere-developer-experience/main/cohere-openapi.yaml',
      )
      expect(result.sources[0]?.hash).toMatch(/^[0-9a-f]{64}$/)
    } finally {
      globalThis.fetch = original
    }
  })
})
