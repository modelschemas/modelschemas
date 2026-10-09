import hostDocs from '../fixtures/host-native-reasoning.json'
import { describe, expect, it } from 'vitest'

import { price } from '@modelschemas/rate-card'
import type { RateCard } from '@modelschemas/rate-card'

import { provider } from './fireworks.ts'
import chatSpec from '../fixtures/fireworks-chat-spec.json'
import serverlessBody from '../fixtures/fireworks-serverless.json'
import { FIREWORKS_SERVERLESS_URL } from '../fireworks-facts.ts'
import { FIREWORKS_PRICING_URL } from '../fireworks-pricing.ts'

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
    expect(provider.perModelSchemaFlags).toEqual([
      'reasoning',
      'reasoning_effort',
    ])
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

describe('fireworks listModels docs', () => {
  it('merges serverless prices with the spec families', async () => {
    const original = globalThis.fetch
    globalThis.fetch = ((url: string) => {
      const href = String(url)
      if (href.includes('/inference/v1/models')) {
        return Promise.resolve(
          Response.json({
            data: [
              {
                id: 'accounts/fireworks/models/deepseek-v4p1-flash',
                context_length: 1048576,
                kind: 'HF_BASE_MODEL',
                supports_chat: true,
                supports_tools: true,
              },
              {
                id: 'accounts/fireworks/models/inkling',
                context_length: 1048576,
                kind: 'HF_BASE_MODEL',
                supports_chat: true,
              },
              {
                id: 'accounts/fireworks/models/qwen3p8-max',
                kind: 'HF_BASE_MODEL',
                supports_chat: true,
                supports_tools: true,
              },
              {
                id: 'accounts/fireworks/models/ember-1',
                kind: 'HF_BASE_MODEL',
                supports_chat: true,
                supports_tools: true,
              },
              {
                id: 'accounts/fireworks/models/qwen3-reranker-8b',
                kind: 'HF_BASE_MODEL',
                supports_chat: true,
              },
            ],
          }),
        )
      }
      for (const [id, body] of Object.entries(hostDocs.fireworks)) {
        if (
          href ===
          'https://api.fireworks.ai/v1/accounts/fireworks/models/' + id
        )
          return Promise.resolve(Response.json(body))
      }
      if (href.includes('/v1/serverless/models')) {
        return Promise.resolve(Response.json(serverlessBody))
      }
      if (href.includes('serverless/pricing.md')) {
        return Promise.resolve(
          new Response(
            '| Model | Standard | Priority |\n| - | - | - |\n| [DeepSeek V4.1 Flash](https://app.fireworks.ai/models/fireworks/deepseek-v4p1-flash) | $0.30 / $0.006 / $1.20 | $0.375 / $0.0075 / $1.50 |\n',
          ),
        )
      }
      if (href.includes('text-completion.openapi.yaml')) {
        return Promise.resolve(Response.json(chatSpec))
      }
      return Promise.resolve(new Response('missing', { status: 404 }))
    }) as typeof fetch
    try {
      const { models, docsFailures } = await provider.listModels({
        FIREWORKS_API_KEY: 'test',
      })
      const deepseek = models.find((model) => model.rawId.includes('deepseek'))
      const inkling = models.find((model) => model.rawId.includes('inkling'))
      const qwen = models.find((model) => model.rawId.includes('qwen3p8-max'))
      const ember = models.find((model) => model.rawId.includes('ember-1'))
      const rerank = models.find((model) => model.rawId.includes('reranker'))
      expect(docsFailures?.failed).toBe(0)
      expect(deepseek?.factSources?.contextWindow).toMatchObject({
        derivation: 'listing',
        sourceUrl: MODELS_URL,
        path: 'context_length',
      })
      expect(deepseek?.factSources?.pricing?.sourceUrl).toBe(
        FIREWORKS_PRICING_URL,
      )
      expect(deepseek?.reasoning?.efforts).toContain('none')
      expect(deepseek?.requestMap?.maxTokensField).toBe('max_tokens')
      expect(inkling?.factSources?.pricing?.sourceUrl).toBe(
        FIREWORKS_SERVERLESS_URL,
      )
      expect(
        price(
          inkling?.pricing as RateCard,
          {},
          {
            input_tokens: 1e6,
            output_tokens: 0,
          },
        ),
      ).toBeCloseTo(1)
      expect(qwen?.contextWindow ?? null).toBeNull()
      expect(qwen?.reasoning?.mode).toBe('effort')
      expect(qwen?.capabilities).toEqual(['tools', 'reasoning'])
      expect(ember?.reasoning ?? null).toBeNull()
      expect(ember?.capabilities).toEqual(['tools', 'reasoning'])
      expect(inkling?.capabilities).toContain('reasoning')
      expect(ember?.factSources?.capabilities?.reasoning?.sourceUrl).toBe(
        'https://api.fireworks.ai/v1/accounts/fireworks/models/ember-1',
      )
      expect(ember?.requestMap?.reasoningEffort).toBeNull()
      expect(rerank?.activity).toBeNull()
      expect(rerank?.requestMap ?? null).toBeNull()
    } finally {
      globalThis.fetch = original
    }
  })
})
