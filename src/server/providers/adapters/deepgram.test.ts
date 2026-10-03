import { afterEach, describe, expect, it } from 'vitest'

import { DEEPGRAM_PRICING_URL } from '../deepgram-pricing.ts'
import { provider } from './deepgram.ts'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('deepgram provider', () => {
  it('exports seed metadata for auto-registration', () => {
    expect(provider.id).toBe('deepgram')
    expect(provider.displayName).toBe('Deepgram')
    expect(provider.authEnvVar).toBe('DEEPGRAM_API_KEY')
    expect(provider.specSourceUrl).toBe(
      'https://developers.deepgram.com/openapi.json',
    )
    expect(provider.modelsEndpoint).toBe('https://api.deepgram.com/v1/models')
    expect(provider.defaultDerivation).toBe('upstream-spec')
  })
})

describe('deepgram classify', () => {
  it('maps listen, speak, and agent converse to audio', () => {
    expect(provider.classify('/v1/listen', {})).toBe('audio')
    expect(provider.classify('/v2/listen', {})).toBe('audio')
    expect(provider.classify('/v1/speak', {})).toBe('audio')
    expect(provider.classify('/v2/speak', {})).toBe('audio')
    expect(provider.classify('/v1/agent/converse', {})).toBe('audio')
  })

  it('drops project, key, auth, read, and models surfaces', () => {
    expect(provider.classify('/v1/projects', {})).toBeNull()
    expect(provider.classify('/v1/projects/{project_id}/keys', {})).toBeNull()
    expect(provider.classify('/v1/projects/{project_id}/agents', {})).toBeNull()
    expect(provider.classify('/v1/auth/grant', {})).toBeNull()
    expect(provider.classify('/v1/read', {})).toBeNull()
    expect(provider.classify('/v1/models', {})).toBeNull()
  })
})

describe('deepgram listModels', () => {
  it('skips when the API key is absent', async () => {
    const result = await provider.listModels({})
    expect(result.models).toEqual([])
    expect(result.skipped).toBe('deepgram: DEEPGRAM_API_KEY not set — skipped')
  })

  it('lists STT and TTS models with Token auth', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      if (String(url) === DEEPGRAM_PRICING_URL) {
        return Promise.resolve(
          new Response(
            [
              '{"name":"Deepgram Voice AI Platform Pricing - Streaming - Flux English - Pay As You Go","price":"0.0065"}',
              '{"name":"Deepgram Voice AI Platform Pricing - Streaming - Flux Multilingual - Pay As You Go","price":"0.0078"}',
              '{"name":"Deepgram Voice AI Platform Pricing - Streaming - Nova-3 Monolingual - Pay As You Go","price":"0.0048"}',
              '{"name":"Deepgram Voice AI Platform Pricing - Streaming - Nova-3 Multilingual - Pay As You Go","price":"0.0058"}',
              '{"name":"Deepgram Voice AI Platform Pricing - Pre-Recorded - Nova-3 Monolingual - Pay As You Go","price":"0.0043"}',
              '{"name":"Deepgram Voice AI Platform Pricing - Pre-Recorded - Nova-3 Multilingual - Pay As You Go","price":"0.0052"}',
              '{"name":"Deepgram Voice AI Platform Pricing - Flux TTS - Pay As You Go","price":"0.0450"}',
              '{"name":"Deepgram Voice AI Platform Pricing - Aura-2 - Pay As You Go","price":"0.030"}',
              '{"name":"Deepgram Voice AI Platform Pricing - Aura-1 - Pay As You Go","price":"0.0150"}',
              '$0.0065/min $0.0078/min $0.0048/min $0.0058/min $0.0043/min $0.0052/min $0.0450/1k $0.030/1k $0.0150/1k',
            ].join(' '),
          ),
        )
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            stt: [{ name: 'Nova-3', canonical_name: 'nova-3' }],
            tts: [
              { name: 'Aura-2 Thalia', canonical_name: 'aura-2-thalia-en' },
              { name: 'Nova-2', canonical_name: 'nova-2-general' },
            ],
          }),
        ),
      )
    }) as typeof fetch

    const result = await provider.listModels({ DEEPGRAM_API_KEY: 'test-key' })
    expect(result.skipped).toBeUndefined()
    expect(result.models.map((model) => model.rawId)).toEqual([
      'nova-3',
      'aura-2-thalia-en',
      'nova-2-general',
    ])
    expect(result.models[0]?.pricing).toBeTruthy()
    expect(result.models[1]?.pricing).toBeTruthy()
    expect(result.models[2]?.pricing ?? null).toBeNull()
    expect(calls[0]).toEqual({
      url: 'https://api.deepgram.com/v1/models',
      init: { headers: { Authorization: 'Token test-key' } },
    })
    expect(calls[1]?.url).toBe(DEEPGRAM_PRICING_URL)
  })
})

describe('deepgram fetchSpec', () => {
  it('loads the public OpenAPI document without a key', async () => {
    const spec = {
      openapi: '3.1.0',
      info: { title: 'REST API', version: '1.0.0' },
      paths: {
        '/v1/listen': { post: { summary: 'Transcribe' } },
      },
    }
    const urls: Array<string> = []
    globalThis.fetch = ((url: string) => {
      urls.push(String(url))
      return Promise.resolve(new Response(JSON.stringify(spec)))
    }) as typeof fetch

    const result = await provider.fetchSpec({})
    expect(urls).toEqual(['https://developers.deepgram.com/openapi.json'])
    expect(result.skipped).toBeUndefined()
    expect(result.outputStrategy).toBe('post-200')
    expect(result.specs).toHaveLength(1)
    expect(result.specs[0]?.info?.title).toBe('REST API')
    expect(result.sources[0]?.url).toBe(
      'https://developers.deepgram.com/openapi.json',
    )
    expect(result.sources[0]?.hash).toMatch(/^[0-9a-f]{64}$/)
  })
})
