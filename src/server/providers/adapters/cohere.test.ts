import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { chatRequestMap } from '../request-map.ts'
import { provider } from './cohere.ts'

const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')

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

describe('cohere request map', () => {
  it('states only what the /v2/chat spec does', () => {
    expect(chatRequestMap('cohere', 'command-a-03-2025', 'chat')).toMatchObject(
      {
        maxTokensField: 'max_tokens',
        developerRole: false,
        reasoningEffort: false,
        thinking: null,
        strictTools: null,
      },
    )
    expect(chatRequestMap('cohere', 'embed-v4.0', 'embeddings')).toBeNull()
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
      if (href.endsWith('/docs/models.md')) {
        return Promise.resolve(new Response(fixture('cohere-models.md.txt')))
      }
      if (href.endsWith('aya-expanse.md')) {
        return Promise.resolve(new Response('| `c4ai-aya-expanse-32b` |'))
      }
      if (href.includes('docs.cohere.com')) {
        return Promise.resolve(
          new Response(
            `Cohere's reasoning models are *hybrid*, meaning reasoning can be enabled (in which case they think) or disabled (in which case they do not).\nmodel="command-a-reasoning-08-2025"\n"type": "disabled" turns off thinking\ntoken_budget: 500\n`,
          ),
        )
      }
      if (href === 'https://cohere.com/pricing') {
        return Promise.resolve(new Response(fixture('cohere-pricing.html.txt')))
      }
      if (href.includes('page_token=page-2')) {
        return Promise.resolve(
          Response.json({
            models: [
              {
                name: 'embed-v4.0',
                endpoints: ['embed'],
                context_length: 128000,
                features: null,
              },
            ],
          }),
        )
      }
      // Rows as `GET /v1/models` returned them on 2026-10-07.
      return Promise.resolve(
        Response.json({
          models: [
            {
              name: 'command-r7b-12-2024',
              endpoints: ['generate', 'chat'],
              context_length: 132000,
              features: [
                'logprobs',
                'json_mode',
                'json_schema',
                'strict_tools',
                'safety_modes',
                'tools',
                'tool_choice',
                'citations',
              ],
            },
            {
              name: 'north-mini-code-1-0',
              endpoints: ['generate', 'chat'],
              context_length: 436000,
              features: [
                'logprobs',
                'strict_tools',
                'safety_modes',
                'tools',
                'reasoning',
              ],
            },
            {
              name: 'c4ai-aya-vision-32b',
              endpoints: ['chat'],
              context_length: 16384,
              features: ['logprobs', 'vision', 'citations'],
            },
            {
              name: 'c4ai-aya-expanse-32b',
              endpoints: ['generate', 'chat'],
              context_length: 128000,
              features: null,
            },
            {
              name: 'command-r7b-arabic-02-2025',
              endpoints: ['generate', 'chat'],
              context_length: 128000,
              features: ['logprobs', 'tools', 'tool_choice'],
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
      const byId = new Map(result.models.map((m) => [m.rawId, m]))

      const r7b = byId.get('command-r7b-12-2024')
      expect(r7b).toMatchObject({
        activity: 'chat',
        contextWindow: 132000,
        maxOutput: 4000,
        modalities: { input: ['text'], output: ['text'] },
        capabilities: [
          'tools',
          'tool_choice',
          'structured_outputs',
          'response_format',
          'logprobs',
        ],
        exactCapabilities: true,
        schemaEndpointId: 'v2/chat',
      })
      expect(r7b?.reasoning).toBeUndefined()
      expect(r7b?.pricing).toMatchObject({
        tables: {
          rate: { base: { input_tokens: 3.75e-8, output_tokens: 1.5e-7 } },
        },
      })
      expect(r7b?.factSources).toMatchObject({
        maxOutput: {
          derivation: 'docs-derived',
          sourceUrl: 'https://docs.cohere.com/docs/models.md',
        },
        modalities: { sourceUrl: 'https://docs.cohere.com/docs/models.md' },
        pricing: { sourceUrl: 'https://cohere.com/pricing' },
      })

      // The guide names one model; the listing's flag carries the rest.
      const north = byId.get('north-mini-code-1-0')
      expect(north?.reasoning).toEqual({ mode: 'budget', mandatory: false })
      expect(north?.maxOutput).toBe(64000)
      expect(north?.pricing).toBeUndefined()

      const vision = byId.get('c4ai-aya-vision-32b')
      expect(vision?.capabilities).toEqual(['logprobs'])
      expect(vision?.modalities).toEqual({
        input: ['text', 'image'],
        output: ['text'],
      })

      // No `features`: flags stay unknown, and the shared body adds none.
      const expanse = byId.get('c4ai-aya-expanse-32b')
      expect(expanse?.capabilities).toBeUndefined()
      expect(expanse?.exactCapabilities).toBe(true)
      expect(expanse?.maxOutput).toBe(4000)
      expect(expanse?.pricing).toMatchObject({
        tables: { rate: { base: { input_tokens: 5e-7 } } },
      })

      // Absent from the models page: listing facts only, no output cap.
      const arabic = byId.get('command-r7b-arabic-02-2025')
      expect(arabic?.maxOutput).toBeUndefined()
      expect(arabic?.modalities).toEqual({ input: ['text'], output: ['text'] })
      expect(arabic?.factSources).toBeUndefined()
      expect(arabic?.pricing).toBeUndefined()

      expect(byId.get('embed-v4.0')).toEqual({
        rawId: 'embed-v4.0',
        contextWindow: 128000,
        activity: 'embeddings',
        deprecated: false,
      })
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
