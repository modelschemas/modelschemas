import { afterEach, describe, expect, it } from 'vitest'

import {
  BASETEN_CHAT_OPENAPI_URL,
  BASETEN_MESSAGES_OPENAPI_URL,
  BASETEN_MODELS_URL,
  BASETEN_REASONING_URL,
  parseBasetenModels,
  provider,
} from './baseten.ts'
import { reasoningViolation } from '../types.ts'

const REASONING = `
## Control reasoning

| Model | Slug | Reasoning | Control |
| - | - | - | - |
| Beam | \`reflection/Beam-1.0\` | Always on | None |
| GLM 5.3 | \`zai-org/GLM-5.3\` | On by default | \`reasoning_effort\` |
| Nemotron Ultra | \`nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B\` | Off by default | \`chat_template_args\` |
| OpenAI GPT 120B | \`openai/gpt-oss-120b\` | On by default | \`reasoning_effort\` |

<span id="control-reasoning-depth" />

### Set reasoning depth

| Model | Supported values | Effective depth |
| - | - | - |
| Beam | \`minimal\`, \`low\`, \`medium\`, \`high\`, \`xhigh\`, \`max\` | As sent |
| GLM 5.3 | \`none\`, \`low\`, \`high\` (default), \`max\` | \`none\` runs at \`low\` |
| Kimi K3 | \`none\`, \`low\`, \`high\`, \`max\` (default) | As sent |
| Nemotron Super 3.5 | \`none\` (default), \`high\` | \`none\` turns reasoning off; every other value runs at one depth, \`high\` |
| OpenAI GPT 120B | \`none\`, \`low\`, \`medium\` (default), \`high\` | \`none\` can still reason; other values as sent |

### Set a reasoning budget

| Model | Supported values |
| - | - |
| Nemotron Ultra | \`none\`, \`high\` |

## Parse the response

| Model | Supported values |
| - | - |
| Nemotron Ultra | \`none\`, \`high\` |
`

const PAYLOAD = {
  data: [
    {
      id: 'reflection/Beam-1.0',
      name: 'Beam',
      output_modalities: ['text'],
      pricing: { prompt: '0.000001', completion: '0.000004' },
    },
    {
      id: 'zai-org/GLM-5.3',
      name: 'GLM 5.3',
      created: 1787927191,
      context_length: 1048576,
      max_completion_tokens: 262144,
      input_modalities: ['text', 'image'],
      output_modalities: ['text'],
      pricing: {
        prompt: '0.0000014',
        completion: '0.0000044',
        image: '0',
        request: '0',
        input_cache_read: '0.00000014',
      },
    },
    {
      id: 'openai/gpt-oss-120b',
      name: 'OpenAI GPT 120B',
      created: 1754410981,
      context_length: 128072,
      max_completion_tokens: 128072,
      input_modalities: ['text'],
      output_modalities: ['text'],
      pricing: {
        prompt: '0.0000001',
        completion: '0.0000005',
        image: '0',
        request: '0',
        input_cache_read: '0.0000001',
      },
    },
    {
      id: 'nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B',
      name: 'Nemotron Ultra',
      created: 1780594202,
      context_length: 202800,
      max_completion_tokens: 202800,
      input_modalities: ['text'],
      output_modalities: ['text'],
      pricing: {
        prompt: '0.0000006',
        completion: '0.0000024',
        input_cache_read: '0',
      },
    },
  ],
}

const HASH = 'a'.repeat(64)
const SOURCE = {
  url: BASETEN_MODELS_URL,
  hash: HASH,
  extractedAt: '2026-10-06T00:00:00.000Z',
}

const SPEC = {
  openapi: '3.1.0',
  paths: { '/v1/chat/completions': { post: {} } },
}
const MESSAGES = { openapi: '3.1.0', paths: { '/v1/messages': { post: {} } } }

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('baseten', () => {
  it('reads per-token prices and joins efforts by display name', () => {
    const models = parseBasetenModels(PAYLOAD, REASONING, SOURCE, HASH)
    const byId = new Map(models.map((model) => [model.rawId, model]))

    expect(byId.get('zai-org/GLM-5.3')).toMatchObject({
      displayName: 'GLM 5.3',
      activity: 'chat',
      contextWindow: 1048576,
      maxOutput: 262144,
      modalities: { input: ['text', 'image'], output: ['text'] },
      releasedAt: 1787927191,
      reasoning: {
        mode: 'effort',
        mandatory: true,
        efforts: ['low', 'high', 'max'],
      },
      pricing: {
        tables: {
          rate: {
            base: {
              input_tokens: 0.0000014,
              output_tokens: 0.0000044,
              cache_read_tokens: 0.00000014,
            },
          },
        },
      },
    })
    expect(byId.get('openai/gpt-oss-120b')?.pricing).toMatchObject({
      tables: {
        rate: {
          base: {
            input_tokens: 0.0000001,
            output_tokens: 0.0000005,
            cache_read_tokens: 0.0000001,
          },
        },
      },
    })
    expect(byId.get('zai-org/GLM-5.3')?.pricing).not.toHaveProperty(
      'tables.rate.base.image',
    )
    expect(
      byId.get('nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B')?.reasoning,
    ).toBeNull()
    expect(
      byId.get('nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B')?.pricing,
    ).not.toHaveProperty('tables.rate.base.cache_read_tokens')
    expect(byId.get('zai-org/GLM-5.3')?.factSources?.reasoning?.sourceUrl).toBe(
      BASETEN_REASONING_URL,
    )
  })

  it('reads mandatory from what effective depth says about none', () => {
    const names = ['Beam', 'Kimi K3', 'Nemotron Super 3.5', 'OpenAI GPT 120B']
    const models = parseBasetenModels(
      { data: names.map((name) => ({ id: name, name })) },
      REASONING,
      SOURCE,
      HASH,
    )
    const reasoning = new Map(
      models.map((model) => [model.rawId, model.reasoning]),
    )

    expect(reasoning.get('Beam')).toEqual({
      mode: 'effort',
      mandatory: true,
      efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    })
    expect(reasoning.get('Kimi K3')?.mandatory).toBe(false)
    expect(reasoning.get('Nemotron Super 3.5')?.mandatory).toBe(false)
    expect(reasoning.get('OpenAI GPT 120B')).toEqual({
      mode: 'effort',
      mandatory: null,
      efforts: ['none', 'low', 'medium', 'high'],
    })
    for (const model of models) {
      expect(reasoningViolation(model.reasoning)).toBeNull()
    }
  })

  it('reads the table under the older ## heading too', () => {
    const models = parseBasetenModels(
      PAYLOAD,
      REASONING.replace(
        '### Set reasoning depth',
        '## Control reasoning depth',
      ),
      SOURCE,
      HASH,
    )
    expect(
      models.find((model) => model.rawId === 'zai-org/GLM-5.3')?.reasoning
        ?.efforts,
    ).toEqual(['low', 'high', 'max'])
  })

  it('throws when the reasoning page has no effort table', () => {
    expect(() =>
      parseBasetenModels(
        PAYLOAD,
        REASONING.replace('### Set reasoning depth', '### Depth'),
        SOURCE,
        HASH,
      ),
    ).toThrow(/no effort table/)
  })

  it('throws when the payload has no ids', () => {
    expect(() =>
      parseBasetenModels({ data: [] }, REASONING, SOURCE, HASH),
    ).toThrow(/listed no ids/)
  })

  it('skips without a key and lists from the inference host with one', async () => {
    const urls: Array<string> = []
    const headers: Array<string> = []
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      urls.push(String(url))
      const authorization = new Headers(init?.headers).get('Authorization')
      if (authorization) headers.push(authorization)
      const body =
        String(url) === BASETEN_MODELS_URL
          ? JSON.stringify(PAYLOAD)
          : String(url) === BASETEN_REASONING_URL
            ? REASONING
            : String(url) === BASETEN_CHAT_OPENAPI_URL
              ? JSON.stringify(SPEC)
              : String(url) === BASETEN_MESSAGES_OPENAPI_URL
                ? JSON.stringify(MESSAGES)
                : null
      if (body === null) {
        return Promise.reject(new Error(`unexpected fetch: ${String(url)}`))
      }
      return Promise.resolve(new Response(body))
    }) as typeof fetch

    const skipped = await provider.listModels({})
    expect(skipped.skipped).toBe('baseten: BASETEN_API_KEY not set — skipped')
    expect(skipped.models).toEqual([])
    expect(urls).toEqual([])

    const listed = await provider.listModels({ BASETEN_API_KEY: 'test-key' })
    const spec = await provider.fetchSpec({})

    expect(listed.skipped).toBeUndefined()
    expect(listed.models).toHaveLength(4)
    expect(headers).toEqual(['Bearer test-key'])
    expect(spec.sources.map((source) => source.url)).toEqual([
      BASETEN_CHAT_OPENAPI_URL,
      BASETEN_MESSAGES_OPENAPI_URL,
    ])
    expect(
      urls.some((url) =>
        /models\.dev|openrouter|baseten\.co\/pricing/i.test(url),
      ),
    ).toBe(false)
    expect(urls).toEqual([
      BASETEN_MODELS_URL,
      BASETEN_REASONING_URL,
      BASETEN_CHAT_OPENAPI_URL,
      BASETEN_MESSAGES_OPENAPI_URL,
    ])
  })
})
