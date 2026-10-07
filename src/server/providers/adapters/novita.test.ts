import { price } from '@modelschemas/rate-card'
import type { RateCard } from '@modelschemas/rate-card'
import { describe, expect, it } from 'vitest'

import { OPENAI_OPENAPI_URL } from '../openai-compat.ts'
import {
  NOVITA_CHAT_DOC_URL,
  NOVITA_FAQ_URL,
  NOVITA_PRODUCT_MODELS_URL,
} from '../novita-facts.ts'
import { provider } from './novita.ts'

const OPENAI_FIXTURE = JSON.stringify({
  openapi: '3.1.0',
  info: { title: 'OpenAI API', version: '2.3.0' },
  servers: [{ url: 'https://api.openai.com/v1' }],
  paths: {
    '/chat/completions': { post: { operationId: 'createChatCompletion' } },
    '/images/generations': { post: { operationId: 'createImage' } },
    '/embeddings': { post: { operationId: 'createEmbedding' } },
    '/files': { get: { operationId: 'listFiles' } },
  },
})

describe('novita adapter', () => {
  it('is a generated OpenAI-compatible adapter for chat and image', () => {
    expect(provider.id).toBe('novita')
    expect(provider.displayName).toBe('Novita AI')
    expect(provider.authEnvVar).toBe('NOVITA_API_KEY')
    expect(provider.defaultDerivation).toBe('generated')
    expect(provider.specSourceUrl).toBe(OPENAI_OPENAPI_URL)
    expect(provider.modelsEndpoint).toBe(
      'https://api.novita.ai/openai/v1/models',
    )
  })

  it('classifies generation paths and drops platform ones', () => {
    expect(provider.classify('/chat/completions', {})).toBe('chat')
    expect(provider.classify('/v1/chat/completions', {})).toBe('chat')
    expect(provider.classify('/images/generations', {})).toBe('image')
    expect(provider.classify('/v1/images/generations', {})).toBe('image')
    expect(provider.classify('/files', {})).toBeNull()
    expect(provider.classify('/v1/models', {})).toBeNull()
    expect(provider.classify('/openai/v1/models', {})).toBeNull()
  })

  it('skips listModels when NOVITA_API_KEY is absent', async () => {
    const { models, skipped } = await provider.listModels({})
    expect(models).toEqual([])
    expect(skipped).toBe('novita: NOVITA_API_KEY not set — skipped')
  })

  it('fetchSpec keeps chat + image paths and rewrites the server', async () => {
    const original = globalThis.fetch
    const urls: Array<string> = []
    globalThis.fetch = ((url: string) => {
      urls.push(String(url))
      expect(String(url)).toBe(OPENAI_OPENAPI_URL)
      return Promise.resolve(
        new Response(OPENAI_FIXTURE, {
          headers: { 'content-type': 'application/json' },
        }),
      )
    }) as typeof fetch
    try {
      const fetched = await provider.fetchSpec({})
      expect(urls).toEqual([OPENAI_OPENAPI_URL])
      expect(fetched.outputStrategy).toBe('post-200')
      expect(fetched.sources).toHaveLength(1)
      expect(fetched.sources[0]?.url).toBe(OPENAI_OPENAPI_URL)
      expect(fetched.sources[0]?.hash).toMatch(/^[0-9a-f]{64}$/)
      const spec = fetched.specs[0]
      expect(spec?.info?.title).toBe('Novita AI')
      expect(spec?.servers).toEqual([
        { url: 'https://api.novita.ai/openai/v1' },
      ])
      expect(Object.keys(spec?.paths ?? {})).toEqual([
        '/chat/completions',
        '/images/generations',
      ])
    } finally {
      globalThis.fetch = original
    }
  })

  it('reads tier brackets, request maps, and reasoning from Novita docs', async () => {
    const original = globalThis.fetch
    globalThis.fetch = ((url: string) => {
      const href = String(url)
      if (href.endsWith('/openai/v1/models')) {
        return Promise.resolve(json({ data: LISTED }))
      }
      if (href === NOVITA_CHAT_DOC_URL) {
        return Promise.resolve(text(CHAT_DOC))
      }
      if (href === NOVITA_FAQ_URL) return Promise.resolve(text(FAQ))
      if (href === NOVITA_PRODUCT_MODELS_URL) {
        return Promise.resolve(json(PRODUCT))
      }
      return Promise.resolve(new Response('missing', { status: 404 }))
    }) as typeof fetch
    try {
      const { models, docsFailures } = await provider.listModels({
        NOVITA_API_KEY: 'test',
      })
      expect(docsFailures).toMatchObject({ failed: 0, skipped: 0 })
      const byId = new Map(models.map((model) => [model.rawId, model]))
      const air = byId.get('zai-org/glm-4.5-air')
      expect(air?.reasoning).toEqual({ mode: 'toggle', mandatory: false })
      expect(air?.requestMap?.thinking?.on).toEqual({ enable_thinking: true })
      expect(air?.capabilities).toContain('max_tokens')
      expect(air?.capabilities).toContain('tool_choice')
      expect(air?.capabilities).not.toContain('structured_outputs')
      expect(air?.factSources?.requestMap?.sourceUrl).toBe(NOVITA_CHAT_DOC_URL)
      expect(air?.factSources?.reasoning?.sourceUrl).toBe(
        NOVITA_PRODUCT_MODELS_URL,
      )

      const locked = byId.get('zai-org/glm-5.3')
      expect(locked?.reasoning).toEqual({ mode: 'toggle', mandatory: true })
      expect(locked?.requestMap?.thinking).toBeNull()
      expect(locked?.requestMap?.maxTokensField).toBe('max_tokens')

      const bare = byId.get('paddlepaddle/paddleocr-vl')
      expect(bare?.capabilities).toEqual([
        'max_tokens',
        'temperature',
        'top_p',
        'top_k',
        'stop',
        'seed',
        'frequency_penalty',
        'presence_penalty',
      ])
      expect(bare?.reasoning).toBeUndefined()

      const max = byId.get('qwen/qwen3-max')
      const card = max?.pricing as RateCard
      const input =
        (price(card, {}, { input_tokens: 1000, output_tokens: 0 }) * 1e6) / 1000
      expect(input).toBeCloseTo(0.845, 9)
      expect(max?.factSources?.pricing).toMatchObject({
        sourceUrl: 'https://api.novita.ai/openai/v1/models',
        path: 'tiered_billing_configs',
      })

      expect(byId.get('pic')?.requestMap).toBeUndefined()
    } finally {
      globalThis.fetch = original
    }
  })
})

const CHAT_DOC = `
<ParamField body="messages" type="object[]" required={true}>
    <ParamField body="role" type="string" required={true}>
      Enum: \`system\`, \`user\`, \`assistant\`
    </ParamField>
</ParamField>
<ParamField body="max_tokens" type="integer" required={true}>
</ParamField>
<ParamField body="temperature" type="number | null">
</ParamField>
<ParamField body="top_p" type="number | null">
</ParamField>
<ParamField body="top_k" type="integer | null">
</ParamField>
<ParamField body="stop" type="string | null">
</ParamField>
<ParamField body="seed" type="integer | null">
</ParamField>
<ParamField body="frequency_penalty" type="number | null">
</ParamField>
<ParamField body="presence_penalty" type="number | null">
</ParamField>
<ParamField body="enable_thinking" type="boolean | null">
  Supported models:

  * zai-org/glm-4.5
</ParamField>
`

const FAQ = `
* **moonshotai/kimi-k2-instruct** and **zai-org/glm-4.5-air**: Add \`"enable_thinking": false\` to your request body.
\`\`\`python
{
  "model": "zai-org/glm-4.5-air",
  "enable_thinking": false
}
\`\`\`
`

const PRODUCT = {
  data: [
    {
      id: 'zai-org/glm-4.5-air',
      features_v2: [
        {
          name: 'function-calling',
          enabled: true,
          subFeatures: { tool_choice: true },
        },
        {
          name: 'structured-outputs',
          enabled: true,
          subFeatures: { json_object: true, json_schema: false },
        },
        { name: 'reasoning', enabled: true, subFeatures: { close: true } },
      ],
    },
    {
      id: 'zai-org/glm-5.3',
      features_v2: [
        { name: 'reasoning', enabled: true, subFeatures: { close: false } },
      ],
    },
  ],
}

const LISTED = [
  {
    id: 'zai-org/glm-4.5-air',
    model_type: 'chat',
    features: ['function-calling', 'structured-outputs', 'reasoning'],
  },
  {
    id: 'zai-org/glm-5.3',
    model_type: 'chat',
    features: ['reasoning'],
  },
  {
    id: 'paddlepaddle/paddleocr-vl',
    model_type: 'chat',
  },
  {
    id: 'qwen/qwen3-max',
    model_type: 'chat',
    is_tiered_billing: true,
    pricing: {
      prompt: { price_per_m_decimal: '2.11' },
      completion: { price_per_m_decimal: '8.45' },
    },
    tiered_billing_configs: [
      {
        min_tokens: 1,
        max_tokens: 32768,
        pricing: {
          prompt: { price_per_m_decimal: '0.845' },
          completion: { price_per_m_decimal: '3.38' },
        },
      },
      {
        min_tokens: 32768,
        max_tokens: 258048,
        pricing: {
          prompt: { price_per_m_decimal: '2.11' },
          completion: { price_per_m_decimal: '8.45' },
        },
      },
    ],
  },
  { id: 'pic', model_type: 'image' },
]

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function text(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/markdown' },
  })
}
