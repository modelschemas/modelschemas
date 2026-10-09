import { GATEWAY_REST_DOCS } from '../cloudflare-gateway-schema.ts'
import { afterEach, describe, expect, it } from 'vitest'

import {
  CATALOG_DIR_URL,
  CATALOG_URL,
  catalogFileUrls,
  parseCatalogModel,
  provider,
} from './cloudflare-ai-gateway.ts'

const HASH = 'a'.repeat(64)
const SOURCE = {
  url: 'https://raw.githubusercontent.com/cloudflare/cloudflare-docs/production/src/content/catalog-models/anthropic-claude-fable-5.json',
  hash: HASH,
  extractedAt: '2026-10-07T00:00:00.000Z',
}

const FABLE_URL =
  'https://raw.githubusercontent.com/cloudflare/cloudflare-docs/production/src/content/catalog-models/anthropic-claude-fable-5.json'
const SEEDANCE_URL =
  'https://raw.githubusercontent.com/cloudflare/cloudflare-docs/production/src/content/catalog-models/bytedance-seedance-2.5.json'

function file(url: string): {
  name: string
  type: 'file'
  download_url: string
} {
  return {
    name: url.slice(url.lastIndexOf('/') + 1),
    type: 'file',
    download_url: url,
  }
}

const FABLE = {
  model_id: 'anthropic/claude-fable-5',
  name: 'Claude Fable 5',
  task: 'Text Generation',
  tags: ['LLM', 'Reasoning'],
  context_length: 1_000_000,
  max_output_tokens: 128_000,
  pricing: {
    'Input tokens (per 1M)': 10,
    'Output tokens (per 1M)': 50,
    'Cached input tokens (per 1M)': 1,
    'Cache creation tokens (per 1M)': 12.5,
  },
  metadata: { 'Adaptive Thinking': 'Yes' },
  schema: {
    input: {
      type: 'object',
      properties: {
        messages: {},
        max_tokens: { type: 'integer' },
        system: {},
        stream: {},
        metadata: {},
      },
      required: ['messages', 'max_tokens'],
    },
  },
}

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('cloudflare-ai-gateway', () => {
  it('keeps raw catalog JSON urls and rejects anything else', () => {
    expect(
      catalogFileUrls(
        JSON.stringify([file(FABLE_URL), { name: 'dir', type: 'dir' }]),
      ),
    ).toEqual([FABLE_URL])
    expect(() =>
      catalogFileUrls(
        JSON.stringify([
          {
            name: 'readme',
            type: 'file',
            download_url: FABLE_URL.replace(/\.json$/, '.md'),
          },
        ]),
      ),
    ).toThrow('not a docs JSON file')
    expect(() =>
      catalogFileUrls(
        JSON.stringify([
          {
            name: 'x.json',
            type: 'file',
            download_url:
              'https://example.com/src/content/catalog-models/x.json',
          },
        ]),
      ),
    ).toThrow('not a docs JSON file')
    expect(() => catalogFileUrls('[]')).toThrow('listed no model files')
    expect(() => catalogFileUrls('{}')).toThrow('not a list')
  })

  it('prices flat per-1M tokens and reads context, max output, and max_tokens', () => {
    expect(parseCatalogModel(FABLE, SOURCE)).toMatchObject({
      rawId: 'anthropic/claude-fable-5',
      displayName: 'Claude Fable 5',
      activity: 'chat',
      contextWindow: 1_000_000,
      maxOutput: 128_000,
      pricing: {
        tables: {
          rate: {
            base: {
              input_tokens: 10 / 1_000_000,
              output_tokens: 50 / 1_000_000,
              cache_read_tokens: 1 / 1_000_000,
              cache_write_tokens: 12.5 / 1_000_000,
            },
          },
        },
        source: { url: SOURCE.url },
      },
      requestMap: {
        maxTokensField: 'max_tokens',
        thinking: null,
        reasoningEffort: null,
      },
      factSources: {
        contextWindow: { path: 'context_length', sourceUrl: SOURCE.url },
        maxOutput: { path: 'max_output_tokens' },
        pricing: { path: 'pricing' },
      },
    })
    expect(parseCatalogModel(FABLE, SOURCE).reasoning).toBeUndefined()
    expect(parseCatalogModel(FABLE, SOURCE).capabilities).toEqual(['reasoning'])
  })

  it('leaves per-second, tiered, and extra rate keys unpriced', () => {
    expect(
      parseCatalogModel(
        {
          ...FABLE,
          model_id: 'bytedance/seedance-2.5',
          task: 'Text-to-Video',
          context_length: null,
          max_output_tokens: null,
          pricing: { 'Default (per second)': 0.2312 },
          schema: { input: { type: 'object', properties: {} } },
        },
        SOURCE,
      ),
    ).toMatchObject({ activity: 'video', pricing: null, contextWindow: null })
    expect(
      parseCatalogModel(
        {
          ...FABLE,
          pricing: {
            'Input <=200k (per 1M)': 0.5,
            'Output <=200k (per 1M)': 3,
          },
        },
        SOURCE,
      ).pricing,
    ).toBeNull()
    expect(
      parseCatalogModel(
        {
          ...FABLE,
          model_id: 'typesafe/live-socket',
          task: 'websocket',
          pricing: { total_audio_minutes: 0.05, input_text_messages: 0.01 },
        },
        SOURCE,
      ),
    ).toMatchObject({ activity: null, pricing: null })
  })

  it('does not read a context window that is only a metadata string', () => {
    const parsed = parseCatalogModel(
      {
        ...FABLE,
        model_id: 'alibaba/qwen3.7-plus',
        context_length: null,
        max_output_tokens: null,
        metadata: { 'Context Window': '1M tokens' },
        schema: { input: { type: 'object', properties: {} } },
      },
      SOURCE,
    )
    expect(parsed.contextWindow).toBeNull()
    expect(parsed.maxOutput).toBeNull()
    expect(parsed.pricing).not.toBeNull()
  })

  it('reads input modalities and a configurable effort that matches the schema', () => {
    const schema = {
      input: {
        type: 'object',
        properties: {
          max_tokens: {},
          max_completion_tokens: {},
          reasoning_effort: {
            anyOf: [
              { type: 'string', enum: ['low', 'medium', 'high'] },
              { type: 'null' },
            ],
          },
          tools: {
            anyOf: [
              {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { type: { const: 'function' } },
                },
              },
            ],
          },
        },
      },
    }
    const grok45 = parseCatalogModel(
      {
        ...FABLE,
        model_id: 'xai/grok-4.5',
        context_length: 500_000,
        max_output_tokens: null,
        pricing: { 'Input <200k (per 1M)': 1, 'Output <200k (per 1M)': 2 },
        tags: ['LLM', 'Reasoning', 'Tool Use'],
        metadata: {
          'Input Modalities': 'Text, Image',
          Reasoning: 'Configurable (low, medium, high)',
        },
        schema,
      },
      SOURCE,
      { schemaShared: true },
    )
    expect(grok45).toMatchObject({
      pricing: null,
      modalities: { input: ['text', 'image'], output: ['text'] },
      reasoning: {
        mode: 'effort',
        mandatory: null,
        efforts: ['low', 'medium', 'high'],
      },
      capabilities: ['tools', 'reasoning'],
      requestMap: {
        maxTokensField: null,
        reasoningEffort: true,
        thinking: {
          on: { reasoning_effort: 'high' },
          off: null,
          levels: {
            off: null,
            low: 'low',
            medium: 'medium',
            high: 'high',
            xhigh: null,
          },
        },
      },
      factSources: {
        modalities: { path: 'metadata.Input Modalities' },
        reasoning: { path: 'metadata.Reasoning' },
        capabilities: {
          tools: { path: 'tags' },
          reasoning: { path: 'metadata.Reasoning' },
        },
      },
    })

    const grok46 = parseCatalogModel(
      {
        ...FABLE,
        model_id: 'xai/grok-4.6',
        max_output_tokens: null,
        tags: ['Tool Use'],
        metadata: {
          'Input Modalities': 'Text, Image',
          Reasoning: 'Yes',
        },
        schema,
      },
      SOURCE,
      { schemaShared: true },
    )
    expect(grok46.reasoning).toBeUndefined()
    expect(grok46.requestMap).toBeUndefined()
    expect(grok46.capabilities).toEqual(['tools'])
  })

  it('treats none in a model-specific effort list as thinking that can be turned off', () => {
    const parsed = parseCatalogModel(
      {
        ...FABLE,
        model_id: 'xai/grok-4.3',
        metadata: {
          'Input Modalities': 'Text, Image',
          Reasoning: 'Configurable (none, low, medium, high)',
        },
        schema: {
          input: {
            properties: {
              max_tokens: {},
              max_completion_tokens: {},
              reasoning_effort: { enum: ['none', 'low', 'medium', 'high'] },
              tools: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { type: { const: 'function' } },
                },
              },
            },
          },
        },
      },
      SOURCE,
    )
    expect(parsed.reasoning).toEqual({
      mode: 'effort',
      mandatory: false,
      efforts: ['none', 'low', 'medium', 'high'],
    })
    expect(parsed.requestMap).toMatchObject({
      thinking: {
        on: { reasoning_effort: 'high' },
        off: { reasoning_effort: 'none' },
      },
    })
  })

  it('reads adaptive thinking and output_config effort from a model-specific schema', () => {
    const parsed = parseCatalogModel(
      {
        ...FABLE,
        model_id: 'anthropic/claude-opus-5.5',
        tags: ['LLM'],
        metadata: {
          'Adaptive Thinking': 'Always on',
          'Default Effort': 'Medium',
        },
        schema: {
          input: {
            properties: {
              max_tokens: { type: 'integer' },
              thinking: {
                type: 'object',
                properties: { type: { const: 'adaptive' } },
                required: ['type'],
              },
              output_config: {
                properties: {
                  effort: { enum: ['low', 'medium', 'high', 'xhigh', 'max'] },
                },
              },
              tools: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { type: { type: 'string' } },
                },
              },
            },
            required: ['messages', 'max_tokens'],
          },
        },
      },
      SOURCE,
    )
    expect(parsed.reasoning).toEqual({
      mode: 'adaptive',
      mandatory: true,
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    })
    expect(parsed.capabilities).toEqual(['tools', 'reasoning'])
    expect(parsed.requestMap).toMatchObject({
      maxTokensField: 'max_tokens',
      reasoningEffort: null,
      thinking: {
        on: {
          thinking: { type: 'adaptive' },
          output_config: { effort: 'high' },
        },
        off: null,
      },
    })
  })

  it('reads a unique responses effort field and ignores a shared template', () => {
    const parsed = parseCatalogModel(
      {
        ...FABLE,
        model_id: 'xai/grok-4.20-multi-agent-0309',
        max_output_tokens: null,
        metadata: { 'Tool Use': 'Yes' },
        tags: ['Reasoning'],
        schema: {
          input: {
            properties: {
              max_output_tokens: {},
              reasoning: {
                properties: { effort: { enum: ['low', 'medium', 'high'] } },
              },
              tools: {
                type: 'array',
                items: { properties: { type: { const: 'function' } } },
              },
            },
          },
        },
      },
      SOURCE,
    )
    expect(parsed.reasoning).toEqual({
      mode: 'effort',
      mandatory: null,
      efforts: ['low', 'medium', 'high'],
    })
    expect(parsed.requestMap).toMatchObject({
      maxTokensField: null,
      thinking: { on: { reasoning: { effort: 'high' } } },
    })
    expect(parsed.factSources?.capabilities).toMatchObject({
      tools: { path: 'metadata.Tool Use' },
    })

    const shared = parseCatalogModel(
      {
        ...FABLE,
        model_id: 'openai/gpt-4o',
        metadata: {},
        tags: ['LLM'],
        schema: {
          input: {
            oneOf: [
              {
                properties: {
                  max_output_tokens: {},
                  reasoning: {
                    properties: {
                      effort: { enum: ['none', 'low', 'medium', 'high'] },
                    },
                  },
                  tools: { type: 'array', items: {} },
                },
              },
              {
                properties: {
                  max_tokens: {},
                  max_completion_tokens: {},
                  reasoning_effort: {
                    description:
                      'Optional reasoning control; availability and accepted values are model-dependent.',
                    enum: ['none', 'low', 'medium', 'high'],
                  },
                },
              },
            ],
          },
        },
      },
      SOURCE,
      { schemaShared: true },
    )
    expect(shared.reasoning).toBeUndefined()
    expect(shared.requestMap).toBeUndefined()
    expect(shared.capabilities).toBeUndefined()
  })

  it('reads pareto modalities and a function-calling flag without an empty tools schema', () => {
    const schema = {
      input: {
        properties: {
          max_tokens: {},
          max_completion_tokens: {},
          tools: { type: 'array', items: {} },
          reasoning_effort: {
            description:
              'availability and accepted values are model-dependent.',
            enum: ['none', 'low', 'medium', 'high'],
          },
        },
      },
    }
    const pareto = parseCatalogModel(
      {
        ...FABLE,
        model_id: 'unbiased/pareto',
        context_length: null,
        max_output_tokens: null,
        metadata: { Modalities: 'Text and vision' },
        tags: ['Vision'],
        schema,
      },
      SOURCE,
      { schemaShared: true },
    )
    expect(pareto.modalities).toEqual({
      input: ['text', 'image'],
      output: ['text'],
    })
    expect(pareto.reasoning).toBeUndefined()
    expect(pareto.capabilities).toBeUndefined()
    expect(pareto.contextWindow).toBeNull()

    const kimi = parseCatalogModel(
      {
        ...FABLE,
        model_id: 'moonshotai/kimi-k3',
        metadata: {
          'Function Calling': 'Yes',
          Reasoning: 'Yes (always-on)',
          Vision: 'Yes',
        },
        tags: ['Function Calling', 'Vision'],
        schema,
      },
      SOURCE,
      { schemaShared: true },
    )
    expect(kimi.capabilities).toEqual(['tools'])
    expect(kimi.reasoning).toBeUndefined()
    expect(kimi.modalities).toBeUndefined()
  })

  it('does not store reasoning when metadata says no', () => {
    const parsed = parseCatalogModel(
      {
        ...FABLE,
        model_id: 'xai/grok-4.20-0309-non-reasoning',
        metadata: { Reasoning: 'No' },
        tags: ['LLM'],
        schema: {
          input: {
            properties: {
              max_tokens: {},
              max_completion_tokens: {},
              reasoning_effort: { enum: ['low', 'high'] },
            },
          },
        },
      },
      SOURCE,
    )
    expect(parsed.reasoning).toBeUndefined()
    expect(parsed.requestMap).toBeUndefined()
  })

  it('throws when a published fact is unreadable', () => {
    expect(() =>
      parseCatalogModel(
        { ...FABLE, metadata: { 'Input Modalities': 'Text, smell' } },
        SOURCE,
      ),
    ).toThrow('unknown modality smell')
    expect(() =>
      parseCatalogModel({ ...FABLE, max_output_tokens: '128k' }, SOURCE),
    ).toThrow('max_output_tokens is not a positive integer')
    expect(() =>
      parseCatalogModel(
        {
          ...FABLE,
          metadata: { Reasoning: 'Configurable (foo)' },
          schema: {
            input: { properties: { reasoning_effort: { enum: ['foo'] } } },
          },
        },
        SOURCE,
      ),
    ).toThrow('not a known effort')
    expect(() =>
      parseCatalogModel(
        {
          ...FABLE,
          metadata: { Reasoning: 'Configurable (low, high)' },
          schema: {
            input: {
              properties: {
                reasoning_effort: { enum: ['low', 'medium', 'high'] },
              },
            },
          },
        },
        SOURCE,
      ),
    ).toThrow('does not match the request schema')
    expect(() =>
      parseCatalogModel({ ...FABLE, model_id: '@cf/zai-org/glm' }, SOURCE),
    ).toThrow('Workers AI')
    expect(() =>
      parseCatalogModel(
        { ...FABLE, pricing: { 'Input tokens (per 1M)': '10' } },
        SOURCE,
      ),
    ).toThrow('not a finite number')
  })

  it('lists catalog files and skips a shared effort template', async () => {
    const sharedSchema = {
      input: {
        oneOf: [
          {
            properties: {
              max_output_tokens: {},
              reasoning: {
                properties: {
                  effort: { enum: ['none', 'low', 'medium', 'high'] },
                },
              },
            },
          },
          { properties: { max_tokens: {}, max_completion_tokens: {} } },
        ],
      },
    }
    const gpt4o = FABLE_URL.replace('claude-fable-5', 'openai-gpt-4o')
    const gpt4oMini = FABLE_URL.replace('claude-fable-5', 'openai-gpt-4o-mini')
    const bodies: Record<string, unknown> = {
      [CATALOG_DIR_URL]: [
        file(FABLE_URL),
        file(SEEDANCE_URL),
        file(gpt4o),
        file(gpt4oMini),
      ],
      [FABLE_URL]: FABLE,
      [SEEDANCE_URL]: {
        model_id: 'bytedance/seedance-2.5',
        name: 'Seedance 2.5',
        task: 'Text-to-Video',
        pricing: { 'Default (per second)': 0.2312 },
      },
      [gpt4o]: {
        ...FABLE,
        model_id: 'openai/gpt-4o',
        name: 'GPT-4o',
        metadata: {},
        tags: ['LLM'],
        schema: sharedSchema,
      },
      [gpt4oMini]: {
        ...FABLE,
        model_id: 'openai/gpt-4o-mini',
        name: 'GPT-4o mini',
        metadata: {},
        tags: ['LLM'],
        schema: sharedSchema,
      },
    }

    const urls: Array<string> = []
    globalThis.fetch = ((url: string) => {
      urls.push(String(url))
      if (String(url) === GATEWAY_REST_DOCS)
        return Promise.resolve(new Response(RUN_DOC))
      const body = bodies[String(url)]
      if (body === undefined) {
        return Promise.reject(new Error(`unexpected fetch: ${String(url)}`))
      }
      return Promise.resolve(new Response(JSON.stringify(body)))
    }) as typeof fetch

    const listed = await provider.listModels({})
    const spec = await provider.fetchSpec({})
    expect(listed.models.map((model) => model.rawId)).toEqual([
      'anthropic/claude-fable-5',
      'bytedance/seedance-2.5',
      'openai/gpt-4o',
      'openai/gpt-4o-mini',
    ])
    expect(listed.models[0]?.requestMap).toMatchObject({
      maxTokensField: 'max_tokens',
    })
    expect(listed.models[1]).toMatchObject({ activity: 'video', pricing: null })
    expect(listed.models[2]?.reasoning).toBeUndefined()
    expect(listed.models[2]?.requestMap).toBeUndefined()
    expect(listed.models[3]?.reasoning).toBeUndefined()
    expect(spec.skipped).toBeUndefined()
    expect(spec.bundledEndpoints?.map((endpoint) => endpoint.publicId)).toEqual(
      ['anthropic/claude-fable-5', 'openai/gpt-4o', 'openai/gpt-4o-mini'],
    )
    expect(
      spec.bundledEndpoints?.every(
        (endpoint) =>
          endpoint.path === '/accounts/{account_id}/ai/run' &&
          endpoint.output === undefined,
      ),
    ).toBe(true)
    expect(spec.warnings).toContain(
      'bytedance/seedance-2.5: native activity or input schema unpublished; no schema endpoint',
    )
    expect(spec.specs).toEqual([])
    expect(urls[0]).toBe(CATALOG_DIR_URL)
    expect(provider.modelsEndpoint).toBe(CATALOG_URL)
  })

  it('sends GITHUB_TOKEN only to api.github.com', async () => {
    const seen: Array<{ url: string; authorization: string | null }> = []
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      seen.push({
        url: String(url),
        authorization: new Headers(init?.headers).get('Authorization'),
      })
      const body = String(url) === CATALOG_DIR_URL ? [file(FABLE_URL)] : FABLE
      return Promise.resolve(new Response(JSON.stringify(body)))
    }) as typeof fetch

    await provider.listModels({ GITHUB_TOKEN: 'ghp_test' })
    expect(
      seen.find((call) => call.url === CATALOG_DIR_URL)?.authorization,
    ).toBe('Bearer ghp_test')
    const raw = seen.filter((call) => call.url === FABLE_URL)
    expect(raw.length).toBeGreaterThan(0)
    expect(raw.every((call) => call.authorization === null)).toBe(true)

    seen.length = 0
    await provider.listModels({})
    expect(seen.every((call) => call.authorization === null)).toBe(true)
  })

  it('throws when the directory is empty or two files publish one id', async () => {
    globalThis.fetch = () => Promise.resolve(new Response('[]'))
    await expect(provider.listModels({})).rejects.toThrow(
      'listed no model files',
    )

    globalThis.fetch = ((url: string) => {
      if (String(url) === CATALOG_DIR_URL) {
        return Promise.resolve(
          new Response(JSON.stringify([file(FABLE_URL), file(SEEDANCE_URL)])),
        )
      }
      return Promise.resolve(new Response(JSON.stringify(FABLE)))
    }) as typeof fetch
    await expect(provider.listModels({})).rejects.toThrow(
      'duplicate model id anthropic/claude-fable-5',
    )
  })
})

const RUN_DOC = `| Endpoint | Format | Use case |
| \`POST /ai/run\` | Envelope with \`model\`, \`input\` | All models |
Model-specific parameters go inside \`input\`.
curl -X POST "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/ai/run"`
