import nativeDocs from '../fixtures/native-reasoning-docs.json'
import { describe, expect, it } from 'vitest'

import { price } from '@modelschemas/rate-card'

import { classifyAndBundle } from '#/server/ingest/sync.ts'

import { provider, togetherRateCard } from './together.ts'

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
    const restore = installTogetherFetch()
    try {
      const result = await provider.listModels({ TOGETHER_API_KEY: 'test-key' })
      expect(result.skipped).toBeUndefined()
      expect(result.docsFailures).toEqual({ failed: 0, skipped: 0, first: [] })
      const byId = Object.fromEntries(
        result.models.map((model) => [model.rawId, model]),
      )
      const qwen = byId['Qwen/Qwen3.5-9B']
      expect(qwen).toMatchObject({
        displayName: 'Qwen 3.5 9B',
        activity: 'chat',
        contextWindow: 32768,
        maxOutput: 8192,
        releasedAt: 1692896905,
        modalities: { input: ['text'], output: ['text'] },
        capabilities: ['tools', 'reasoning'],
        reasoning: { mode: 'toggle', mandatory: false },
      })
      expect(qwen?.factSources?.contextWindow).toEqual({
        derivation: 'listing',
        sourceUrl: 'https://api.together.xyz/v1/models',
        path: 'context_length',
      })
      expect(qwen?.factSources?.maxOutput?.path).toBe(
        'config.max_output_length',
      )
      expect(qwen?.factSources?.pricing?.sourceUrl).toBe(
        'https://api.together.xyz/v1/models',
      )
      expect(qwen?.factSources?.modalities?.sourceUrl).toBe(
        'https://api.together.ai/v2/supported-models',
      )
      expect(qwen?.factSources?.reasoning?.sourceUrl).toBe(
        'https://docs.together.ai/docs/inference/chat/reasoning.md',
      )
      const kimi = byId['moonshotai/Kimi-K3']
      expect(kimi?.reasoning).toEqual({
        mode: 'effort',
        mandatory: false,
        efforts: ['low', 'medium', 'high', 'max'],
      })
      expect(kimi?.factSources?.reasoning?.sourceUrl).toBe(
        'https://docs.together.ai/docs/kimi-k3-quickstart.md',
      )
      expect(kimi?.contextWindow).toBe(1048576)
      if (!kimi?.pricing || typeof kimi.pricing !== 'object') {
        throw new Error('kimi card missing')
      }
      expect(
        price(
          kimi.pricing as never,
          {},
          { input_tokens: 1e6, output_tokens: 0 },
        ),
      ).toBeCloseTo(2.7, 9)
      // Audio is priced from the catalog, never the listing's token object.
      expect(byId['hexgrad/Kokoro-82M']?.pricing).toBeTruthy()
      expect(byId['hexgrad/Kokoro-82M']?.absent).toBeUndefined()
      const rime = byId['rime-labs/rime-arcana-v2']
      expect(rime?.pricing).toBeUndefined()
      expect(rime?.absent).toEqual({ pricing: 'cleared' })
      expect(qwen?.absent).toBeUndefined()
      const gpt = byId['openai/gpt-oss-120b']
      expect(gpt?.reasoning).toEqual({
        mode: 'effort',
        mandatory: true,
        efforts: ['low', 'medium', 'high'],
      })
      expect(gpt?.factSources?.reasoning?.sourceUrl).toBe(
        'https://docs.together.ai/docs/gpt-oss.md',
      )
      expect(byId['zai-org/GLM-5.3']?.reasoning).toEqual({
        mode: 'effort',
        mandatory: true,
        efforts: ['low', 'medium', 'high', 'max'],
      })
      expect(byId['zai-org/GLM-5.3']?.contextWindow).toBe(1048575)
      expect(byId['zai-org/GLM-5.3-Flash']?.reasoning).toBeUndefined()
      expect(byId['org/vision-only']?.contextWindow).toBeNull()
      expect(byId['org/vision-only']?.modalities).toEqual({
        input: ['text', 'image'],
        output: ['text'],
      })
      expect(byId['org/vision-only']?.factSources?.modalities?.path).toBe(
        'Vision models',
      )
      const flagged = byId['org/reason-flag']
      expect(flagged?.reasoning).toBeUndefined()
      expect(flagged?.capabilities).toEqual(['reasoning'])
      expect(flagged?.factSources?.reasoning?.path).toBe('silent')
      expect(byId['BAAI/bge-large-en-v1.5']?.activity).toBe('embeddings')
      expect(byId['org/reranker']?.activity).toBeNull()
    } finally {
      restore()
    }
  })

  it('reads a JSON docs-cache hit back into reasoning and chat facts', async () => {
    const docsFetches = { count: 0 }
    const restore = installTogetherFetch(docsFetches)
    const kv = jsonKv()
    try {
      await provider.listModels({ TOGETHER_API_KEY: 'test-key' }, kv)
      const warmed = docsFetches.count
      expect(warmed).toBeGreaterThan(0)
      const result = await provider.listModels(
        { TOGETHER_API_KEY: 'test-key' },
        kv,
      )
      expect(docsFetches.count).toBe(warmed)
      expect(result.docsFailures).toEqual({ failed: 0, skipped: 0, first: [] })
      const byId = Object.fromEntries(
        result.models.map((model) => [model.rawId, model]),
      )
      expect(byId['Qwen/Qwen3.5-9B']?.reasoning).toEqual({
        mode: 'toggle',
        mandatory: false,
      })
      expect(byId['moonshotai/Kimi-K3']?.reasoning).toEqual({
        mode: 'effort',
        mandatory: false,
        efforts: ['low', 'medium', 'high', 'max'],
      })
      expect(byId['openai/gpt-oss-120b']?.reasoning).toEqual({
        mode: 'effort',
        mandatory: true,
        efforts: ['low', 'medium', 'high'],
      })
      expect(byId['zai-org/GLM-5.3']?.contextWindow).toBe(1048575)
      expect(byId['org/vision-only']?.modalities).toEqual({
        input: ['text', 'image'],
        output: ['text'],
      })
    } finally {
      restore()
    }
  })
})

/** KV that stores the same JSON `cachedDocs` writes. A Map comes back as `{}`. */
function jsonKv(): KVNamespace {
  const store = new Map<string, string>()
  return {
    get: (key: string) => Promise.resolve(store.get(key) ?? null),
    put: (key: string, value: string) => {
      store.set(key, value)
      return Promise.resolve()
    },
  } as KVNamespace
}

function installTogetherFetch(docsFetches?: { count: number }): () => void {
  const original = globalThis.fetch
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    const target = String(url)
    const headers = new Headers(init?.headers)
    if (
      target.startsWith('https://api.together.xyz/') ||
      target.startsWith('https://api.together.ai/')
    ) {
      expect(headers.get('Authorization')).toBe('Bearer test-key')
    }
    if (target.includes('/v2/supported-models')) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [
              {
                name: 'Qwen/Qwen3.5-9B',
                inputModalities: ['MODALITY_TEXT'],
                outputModalities: ['MODALITY_TEXT'],
                features: ['FEATURE_TOOL_CALLING', 'FEATURE_REASONING'],
              },
              {
                name: 'org/reason-flag',
                inputModalities: ['MODALITY_TEXT'],
                outputModalities: ['MODALITY_TEXT'],
                features: ['FEATURE_REASONING'],
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
    }
    if (target.includes('.md') && docsFetches) docsFetches.count += 1
    if (target.includes('/deepseek-v4-quickstart.md'))
      return textResponse(
        nativeDocs['https://docs.together.ai/docs/deepseek-v4-quickstart.md'],
      )
    if (target.includes('/serverless/models.md')) {
      return textResponse(LIST_DOCS)
    }
    if (target.includes('/inference/chat/reasoning.md')) {
      return textResponse(
        LIST_REASONING +
          '\n' +
          nativeDocs[
            'https://docs.together.ai/docs/inference/chat/reasoning.md'
          ],
      )
    }
    if (target.includes('/kimi-k3-quickstart.md'))
      return textResponse(LIST_KIMI)
    if (target.includes('/glm-5.3-quickstart.md'))
      return textResponse(
        nativeDocs['https://docs.together.ai/docs/glm-5.3-quickstart.md'],
      )
    if (target.endsWith('/gpt-oss.md')) return textResponse(LIST_GPT)
    expect(target).toBe('https://api.together.xyz/v1/models')
    return Promise.resolve(
      new Response(
        JSON.stringify([
          {
            id: 'Qwen/Qwen3.5-9B',
            display_name: 'Qwen 3.5 9B',
            created: 1692896905,
            type: 'chat',
            context_length: 32768,
            config: { max_output_length: 8192 },
            pricing: { input: 0.17, output: 0.25, cached_input: 0 },
          },
          {
            id: 'moonshotai/Kimi-K3',
            type: 'chat',
            context_length: 1048576,
            pricing: { input: 2.7, output: 13.5, cached_input: 0.27 },
          },
          { id: 'openai/gpt-oss-120b', type: 'chat', context_length: 131072 },
          { id: 'zai-org/GLM-5.3', type: 'chat' },
          {
            id: 'zai-org/GLM-5.3-Flash',
            type: 'chat',
            context_length: 1048575,
          },
          { id: 'org/vision-only', type: 'chat', context_length: 0 },
          { id: 'org/reason-flag', type: 'chat', context_length: 4096 },
          { id: 'BAAI/bge-large-en-v1.5', type: 'embedding' },
          { id: 'org/reranker', type: 'rerank' },
          { id: 'hexgrad/Kokoro-82M', type: 'audio', pricing: { input: 4 } },
          {
            id: 'rime-labs/rime-arcana-v2',
            type: 'audio',
            pricing: { input: 0.27, output: 0 },
          },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
  }) as typeof fetch
  return () => {
    globalThis.fetch = original
  }
}

function textResponse(body: string): Promise<Response> {
  return Promise.resolve(
    new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/markdown' },
    }),
  )
}

const LIST_DOCS = `
## Chat models

| Organization | Model name | API model string | Context length | Input pricing (per 1M tokens) | Cached input pricing (per 1M tokens) | Output pricing (per 1M tokens) | Quantization | Function calling | Structured outputs |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| Qwen | Qwen3.5 9B | Qwen/Qwen3.5-9B | 262144 | \\$0.17 | - | \\$0.25 | FP8 | Yes | Yes |
| Z.ai | GLM-5.3 | zai-org/GLM-5.3 | 1048575 | \\$1.40 | \\$0.26 | \\$4.40 | FP4 | Yes | Yes |

## Vision models

| Organization | Model name | API model string | Context length | Input pricing (per 1M tokens) | Output pricing (per 1M tokens) |
| :- | :- | :- | :- | :- | :- |
| Org | Vision only | org/vision-only | 8192 | \\$1.00 | \\$1.00 |

## Audio models

| Organization | Modality | Model name | Model string for API | Pricing |
| :- | :- | :- | :- | :- |
| Kokoro | Text-to-Speech | Kokoro | hexgrad/Kokoro-82M | \\$4.00 per 1M chars |
`

const LIST_REASONING = `
* **Hybrid:** Supports both reasoning and non-reasoning modes via \`reasoning={"enabled": True/False}\`.
* **Adjustable effort:** Supports the \`reasoning_effort\` parameter to control reasoning depth (\`"low"\`, \`"medium"\`, or \`"high"\`).

## Supported models

| Model | API string | Type | Context length |
| :- | :- | :- | :- |
| Qwen3.5 9B | \`Qwen/Qwen3.5-9B\` | Hybrid (on by default) | 262K |
| Kimi K3 | \`moonshotai/Kimi-K3\` | Hybrid (on by default) | 1M |
| GPT-OSS 120B | \`openai/gpt-oss-120b\` | Adjustable effort | 128K |
`

const LIST_KIMI = `
The model ID is \`moonshotai/Kimi-K3\`.

| Parameter | Behavior on Together |
| - | - |
| \`reasoning_effort\` | \`"low"\`, \`"medium"\`, \`"high"\`, or \`"max"\` (default). |
| \`reasoning\` | \`{"enabled": False}\` disables thinking entirely. |
`

const LIST_GPT = `
The model ID is \`openai/gpt-oss-120b\`.

\`reasoning_effort\` accepts \`"low"\`, \`"medium"\`, and \`"high"\`.

Reasoning cannot be disabled entirely.
`

describe('togetherRateCard', () => {
  it('compiles per-million listing rates into a token card', async () => {
    const card = await togetherRateCard({
      hourly: 0,
      input: 0.88,
      output: 0.88,
      cached_input: 0.2,
      base: 0,
      finetune: 0,
    })
    if (!card) throw new Error('did not compile')
    expect(
      price(card, {}, { input_tokens: 1e6, output_tokens: 0 }),
    ).toBeCloseTo(0.88, 9)
    expect(
      price(
        card,
        {},
        { cache_read_tokens: 1e6, input_tokens: 0, output_tokens: 0 },
      ),
    ).toBeCloseTo(0.2, 9)
    expect(card.source.url).toBe('https://api.together.xyz/v1/models')
  })

  it('serves no card for an all-zero or absent listing', async () => {
    // Issue #111 examples Together does not quote per token.
    expect(
      await togetherRateCard({
        hourly: 0,
        input: 0,
        output: 0,
        cached_input: 0,
        base: 0,
      }),
    ).toBeNull()
    expect(await togetherRateCard(undefined)).toBeNull()
  })
})

describe('together provider', () => {
  it('keeps reasoning flags off the shared chat schema', () => {
    expect(provider.perModelSchemaFlags).toEqual([
      'reasoning',
      'reasoning_effort',
    ])
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
