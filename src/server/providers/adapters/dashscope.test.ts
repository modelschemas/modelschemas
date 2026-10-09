import { describe, expect, it } from 'vitest'
import nativeDocs from '../fixtures/native-reasoning-docs.json'
import { DASHSCOPE_THINKING_URL } from '../dashscope-thinking.ts'

import {
  DASHSCOPE_COMPAT_SCOPE,
  DASHSCOPE_COMPAT_URL,
} from '../dashscope-compat.ts'
import { dashscopeModelPageUrl } from '../dashscope-model-limits.ts'
import { OPENAI_OPENAPI_URL } from '../openai-compat.ts'
import {
  dashscopeListedCard,
  dashscopeListedModel,
  promptFloor,
  provider,
} from './dashscope.ts'

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
      'https://dashscope-intl.aliyuncs.com/api/v1/models',
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
            output: {
              total: 1,
              models: [{ model: 'qwen-plus', name: 'Qwen Plus' }],
            },
          }),
        ),
      () => provider.listModels({ DASHSCOPE_API_KEY: 'test-key' }),
    )
    expect(calls).toEqual([
      {
        url: 'https://dashscope-intl.aliyuncs.com/api/v1/models?page_no=1&page_size=100&language=en-US',
        auth: 'Bearer test-key',
      },
      { url: DASHSCOPE_COMPAT_URL, auth: null },
    ])
    expect(result.skipped).toBeUndefined()
    expect(result.models).toEqual([
      {
        rawId: 'qwen-plus',
        displayName: 'Qwen Plus',
        activity: null,
        contextWindow: null,
        maxOutput: null,
        releasedAt: null,
      },
    ])
    expect(result.docsFailures?.failed).toBe(1)
  })
})

const TOKEN = 'Per 1M tokens'

function rateCell(
  card: Awaited<ReturnType<typeof dashscopeListedCard>>,
  key: string,
): Record<string, number> {
  if (!card) throw new Error('expected a card')
  const rate = card.tables.rate
  if (!rate) throw new Error('expected a rate table')
  const cell = rate[key]
  if (!cell || typeof cell !== 'object') {
    throw new Error(`expected rate.${key}`)
  }
  return Object.fromEntries(
    Object.entries(cell).filter(
      (entry): entry is [string, number] => typeof entry[1] === 'number',
    ),
  )
}

describe('dashscope listing cards', () => {
  it('reads an upper bound as the base tier and the next floor above it', () => {
    expect(promptFloor('Input<=32k')).toBe(0)
    expect(promptFloor('32k<Input<=128k')).toBe(32_000)
    expect(promptFloor('256k<Input<=1m')).toBe(256_000)
    expect(promptFloor('not-a-tier')).toBeNull()
  })

  it('prices the non-thinking standard tier and its prompt floors', async () => {
    const card = await dashscopeListedCard([
      {
        range_name: 'Input<=32k',
        prices: [
          { type: 'input_token', price: '1.2', price_unit: TOKEN },
          { type: 'output_token', price: '6', price_unit: TOKEN },
          { type: 'thinking_output_token', price: '12', price_unit: TOKEN },
          { type: 'input_token_cache', price: '0.24', price_unit: TOKEN },
          { type: 'input_token_batch', price: '0.6', price_unit: TOKEN },
        ],
      },
      {
        range_name: '32k<Input<=128k',
        prices: [
          { type: 'input_token', price: '2.4', price_unit: TOKEN },
          { type: 'output_token', price: '12', price_unit: TOKEN },
          { type: 'input_token_cache', price: '0.48', price_unit: TOKEN },
        ],
      },
    ])
    const base = rateCell(card, 'base')
    expect(base.input_tokens).toBeCloseTo(1.2 / 1e6)
    expect(base.output_tokens).toBeCloseTo(6 / 1e6, 10)
    expect(base.cache_read_tokens).toBeCloseTo(0.24 / 1e6, 10)
    expect(base.output_tokens).not.toBeCloseTo(12 / 1e6, 10)
    const tier = rateCell(card, '32000')
    expect(tier.input_tokens).toBeCloseTo(2.4 / 1e6)
  })

  it('bills thinking rates when the row publishes no plain token price', async () => {
    const card = await dashscopeListedCard([
      {
        range_name: 'Default',
        prices: [
          { type: 'thinking_input_token', price: '0.23', price_unit: TOKEN },
          { type: 'thinking_output_token', price: '2.3', price_unit: TOKEN },
        ],
      },
    ])
    const base = rateCell(card, 'base')
    expect(base.input_tokens).toBeCloseTo(0.23 / 1e6)
    expect(base.output_tokens).toBeCloseTo(2.3 / 1e6)
  })

  it('uses explicit cache read when implicit cache is absent', async () => {
    const card = await dashscopeListedCard([
      {
        range_name: 'Input<=256k',
        prices: [
          { type: 'input_token', price: '0.5', price_unit: TOKEN },
          { type: 'output_token', price: '3', price_unit: TOKEN },
          {
            type: 'input_token_cache_read',
            price: '0.05',
            price_unit: TOKEN,
          },
        ],
      },
    ])
    const base = rateCell(card, 'base')
    expect(base.cache_read_tokens).toBeCloseTo(0.05 / 1e6)
  })

  it('drops peak/off-peak quotes and modality-split quotes', async () => {
    const peak = await dashscopeListedCard([
      {
        range_name: 'Default',
        prices: [
          {
            type: 'input_token',
            price: '0.15',
            price_unit: TOKEN,
            time_band: 'offpeak',
          },
          {
            type: 'input_token',
            price: '0.3',
            price_unit: TOKEN,
            time_band: 'peak',
          },
          {
            type: 'output_token',
            price: '0.6',
            price_unit: TOKEN,
            time_band: 'offpeak',
          },
          {
            type: 'output_token',
            price: '1.2',
            price_unit: TOKEN,
            time_band: 'peak',
          },
        ],
      },
    ])
    const split = await dashscopeListedCard([
      {
        range_name: 'Default',
        prices: [
          { type: 'text_input_token', price: '0.43', price_unit: TOKEN },
          { type: 'audio_input_token', price: '3.81', price_unit: TOKEN },
          {
            type: 'purein_text_output_token',
            price: '1.66',
            price_unit: TOKEN,
          },
        ],
      },
    ])
    expect(peak).toBeNull()
    expect(split).toBeNull()
  })

  it('uses reasoning max output when max output is null', async () => {
    const model = await dashscopeListedModel({
      model: 'qwen3-235b-a22b-thinking-2507',
      capabilities: ['TG'],
      features: [],
      inference_metadata: {
        request_modality: ['Text'],
        response_modality: ['Text'],
      },
      model_info: {
        context_window: 131072,
        max_output_tokens: null,
        reasoning_max_output_tokens: 32768,
      },
    })
    expect(model?.maxOutput).toBe(32768)
    expect(model?.factSources?.maxOutput?.path).toBe(
      'model_info.reasoning_max_output_tokens',
    )
  })
})

const COMPAT_PAGE = `
${DASHSCOPE_COMPAT_SCOPE}
## Request parameters
<table><tbody>
<tr><td><p>messages</p></td><td><p>array</p></td><td><p>-</p></td><td><p>Valid roles: system, user, assistant.</p></td></tr>
<tr><td><p>temperature</p></td><td><p>float</p></td><td><p>-</p></td><td><p>Controls randomness.</p></td></tr>
<tr><td><p>max_tokens</p></td><td><p>integer</p></td><td><p>-</p></td><td><p>The maximum number of tokens the model can generate.</p></td></tr>
</tbody></table>
## Response parameters
`

const OMNI_PAGE = `# qwen3-omni-flash

## Context Limits

<table><tbody><tr><td><p>Context Window</p></td><td><p>65536</p></td><td><p>Max Output Length</p></td><td><p>16384</p></td></tr></tbody></table>

### qwen3-omni-flash-2025-09-15

#### Context Limits

<table><tbody><tr><td><p>Context Window</p></td><td><p>65536</p></td><td><p>Max Output Length</p></td><td><p>16384</p></td></tr></tbody></table>
`

describe('dashscope listModels docs', () => {
  it('stamps the compat request map on chat rows', async () => {
    const { result, calls } = await withStubbedFetch(
      (url) => {
        if (url === DASHSCOPE_THINKING_URL)
          return new Response(nativeDocs[DASHSCOPE_THINKING_URL])
        if (url === DASHSCOPE_COMPAT_URL) return new Response(COMPAT_PAGE)
        return new Response(
          JSON.stringify({
            output: {
              total: 1,
              models: [
                {
                  model: 'qwen-plus',
                  name: 'Qwen Plus',
                  capabilities: ['TG'],
                  features: ['function-calling'],
                  inference_metadata: {
                    request_modality: ['Text'],
                    response_modality: ['Text'],
                  },
                  model_info: {
                    context_window: 1000000,
                    max_output_tokens: 32768,
                  },
                },
              ],
            },
          }),
        )
      },
      () => provider.listModels({ DASHSCOPE_API_KEY: 'test-key' }),
    )
    expect(calls.map((call) => call.url)).toEqual([
      'https://dashscope-intl.aliyuncs.com/api/v1/models?page_no=1&page_size=100&language=en-US',
      DASHSCOPE_THINKING_URL,
      DASHSCOPE_COMPAT_URL,
    ])
    const model = result.models[0]
    expect(model?.requestMap?.maxTokensField).toBe('max_tokens')
    expect(model?.requestMap?.developerRole).toBe(false)
    expect(model?.exactCapabilities).toBe(false)
    expect(model?.capabilities).toEqual([
      'tools',
      'temperature',
      'max_tokens',
      'reasoning',
    ])
    expect(model?.factSources?.capabilities?.temperature?.sourceUrl).toBe(
      DASHSCOPE_COMPAT_URL,
    )
    expect(result.docsFailures).toEqual({ failed: 0, skipped: 0, first: [] })
  })

  it('fills a null context window from the model page', async () => {
    const page = dashscopeModelPageUrl('qwen3-omni-flash-2025-09-15')
    const { result, calls } = await withStubbedFetch(
      (url) => {
        if (url === DASHSCOPE_THINKING_URL)
          return new Response(nativeDocs[DASHSCOPE_THINKING_URL])
        if (url === DASHSCOPE_COMPAT_URL) return new Response(COMPAT_PAGE)
        if (url === page) return new Response(OMNI_PAGE)
        return new Response(
          JSON.stringify({
            output: {
              total: 1,
              models: [
                {
                  model: 'qwen3-omni-flash-2025-09-15',
                  capabilities: ['Multimodal-Omni'],
                  features: [],
                  inference_metadata: {
                    request_modality: ['Text'],
                    response_modality: ['Text'],
                  },
                  model_info: {
                    context_window: null,
                    max_output_tokens: null,
                  },
                },
              ],
            },
          }),
        )
      },
      () => provider.listModels({ DASHSCOPE_API_KEY: 'test-key' }),
    )
    expect(calls.map((call) => call.url)).toContain(page)
    expect(page).toBe(
      'https://www.alibabacloud.com/help/en/model-studio/qwen3-omni-flash.md',
    )
    const model = result.models[0]
    expect(model?.contextWindow).toBe(65536)
    expect(model?.maxOutput).toBe(16384)
    expect(model?.factSources?.contextWindow?.sourceUrl).toBe(page)
    expect(model?.requestMap?.maxTokensField).toBe('max_tokens')
  })

  it('leaves a non-compat chat id off the OpenAI request map', async () => {
    const { result } = await withStubbedFetch(
      (url) => {
        if (url === DASHSCOPE_THINKING_URL)
          return new Response(nativeDocs[DASHSCOPE_THINKING_URL])
        if (url === DASHSCOPE_COMPAT_URL) return new Response(COMPAT_PAGE)
        return new Response(
          JSON.stringify({
            output: {
              total: 1,
              models: [
                {
                  model: 'decision-model-preview',
                  capabilities: ['TG'],
                  features: [],
                  inference_metadata: {
                    request_modality: ['Text'],
                    response_modality: ['Text'],
                  },
                  model_info: {
                    context_window: 65536,
                    max_output_tokens: 0,
                  },
                },
              ],
            },
          }),
        )
      },
      () => provider.listModels({ DASHSCOPE_API_KEY: 'test-key' }),
    )
    const model = result.models[0]
    expect(model?.contextWindow).toBe(65536)
    expect(model?.maxOutput).toBe(0)
    expect(model?.requestMap).toBeUndefined()
    expect(model?.capabilities ?? []).not.toEqual(
      expect.arrayContaining(['temperature', 'max_tokens', 'top_p']),
    )
    expect(model?.factSources?.capabilities?.temperature).toBeUndefined()
    expect(
      provider.generationEndpointId?.({
        rawId: 'decision-model-preview',
        activity: 'chat',
      }),
    ).toBeNull()
    expect(
      provider.generationEndpointId?.({
        rawId: 'qwen-plus',
        activity: 'chat',
      }),
    ).toBe('chat/completions')
  })
})
