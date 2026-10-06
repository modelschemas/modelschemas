import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  falChatFacts,
  falDescriptionContextWindow,
  falEndpointSpecUrl,
} from './fal-chat-facts.ts'
import { falProvider } from './fal.ts'
import chatModels from './fixtures/fal-chat-models.json'
import type { OpenApiDocument } from './types.ts'

const LISTING = 'https://api.fal.ai/v1/models'

interface Fixture {
  endpoint_id: string
  metadata: { category: string; description: string }
  openapi: OpenApiDocument
}

const fixtures = chatModels as unknown as Array<Fixture>

function fixture(rawId: string): Fixture {
  const found = fixtures.find((m) => m.endpoint_id === rawId)
  if (!found) throw new Error(`no fixture for ${rawId}`)
  return structuredClone(found)
}

function facts(model: Fixture) {
  return falChatFacts(
    {
      endpoint_id: model.endpoint_id,
      description: model.metadata.description,
      openapi: model.openapi,
    },
    LISTING,
  )
}

/** The request schema's properties, for mutating a fixture. */
function inputProperties(
  model: Fixture,
): Record<string, Record<string, unknown>> {
  const schemas = model.openapi.components?.schemas ?? {}
  const name = Object.keys(schemas).find((key) => key.endsWith('Input'))
  const schema = schemas[name ?? ''] as {
    properties: Record<string, Record<string, unknown>>
  }
  return schema.properties
}

describe('falChatFacts', () => {
  it('reads a model endpoint from its request schema and description', () => {
    const rawId = 'fal-ai/bytedance/seed/v2/mini'
    const got = facts(fixture(rawId))
    expect(got.contextWindow).toBe(256_000)
    expect(got.maxOutput).toBe(65_536)
    expect(got.modalities).toEqual({
      input: ['text', 'image', 'video'],
      output: ['text'],
    })
    expect(got.reasoning).toEqual({
      mode: 'effort',
      mandatory: false,
      efforts: ['minimal', 'low', 'medium', 'high'],
    })
    expect(got.capabilities).toEqual(
      expect.arrayContaining([
        'reasoning',
        'reasoning_effort',
        'max_tokens',
        'temperature',
        'top_p',
      ]),
    )
    expect(got.factSources?.contextWindow).toEqual({
      derivation: 'listing',
      sourceUrl: LISTING,
      path: 'metadata.description',
    })
    expect(got.factSources?.maxOutput).toEqual({
      derivation: 'upstream-spec',
      sourceUrl: falEndpointSpecUrl(LISTING, rawId),
      endpointId: rawId,
      path: '/properties/max_completion_tokens/maximum',
    })
    expect(got.factSources?.reasoning?.path).toBe(
      '/properties/reasoning_effort',
    )
    expect(got.factSources?.capabilities?.temperature?.sourceUrl).toBe(
      falEndpointSpecUrl(LISTING, rawId),
    )
  })

  it('reads `max_tokens` and a single media field', () => {
    const got = facts(fixture('nvidia/nemotron-3-nano-omni/vision'))
    expect(got.maxOutput).toBe(20_000)
    expect(got.modalities).toEqual({
      input: ['text', 'image'],
      output: ['text'],
    })
    // `reasoning_mode` is a think/no_think switch: no effort config, no flag.
    expect(got.reasoning).toBeUndefined()
    expect(got.capabilities).toEqual(
      expect.arrayContaining(['max_tokens', 'temperature', 'top_p']),
    )
    expect(got.capabilities).not.toContain('reasoning')
    expect(got.contextWindow).toBeUndefined()
  })

  it('reads a spec whose path uses the app alias, not the endpoint id', () => {
    const model = fixture('nvidia/nemotron-3-nano-omni/vision')
    const aliased = Object.fromEntries(
      Object.entries(model.openapi.paths ?? {}).map(([path, operations]) => [
        path.replace('/nvidia/', '/fal-ai/'),
        operations,
      ]),
    )
    model.openapi.paths = aliased
    expect(facts(model).maxOutput).toBe(20_000)
    // Two POST paths: which one is the endpoint is not stated.
    model.openapi.paths = { ...aliased, '/other': { post: {} } }
    expect(facts(model)).toEqual({})
  })

  it('states no window, cap, or reasoning for a router', () => {
    const got = facts(fixture('openrouter/router/video'))
    expect(got.contextWindow).toBeUndefined()
    // `max_tokens` has no maximum: the cap is the routed model's.
    expect(got.maxOutput).toBeUndefined()
    expect(got.reasoning).toBeUndefined()
    expect(got.capabilities).not.toContain('reasoning')
    expect(got.capabilities).toEqual(
      expect.arrayContaining(['max_tokens', 'temperature']),
    )
    expect(got.modalities).toEqual({
      input: ['text', 'video'],
      output: ['text'],
    })
  })

  it('names no text input without a `prompt` field', () => {
    const got = facts(fixture('openrouter/router/decisions'))
    expect(got.modalities).toBeUndefined()
    expect(got.capabilities).toEqual([])
  })

  it('leaves an endpoint with an empty request schema untouched', () => {
    expect(
      facts(fixture('openrouter/router/openai/v1/chat/completions')),
    ).toEqual({})
    const model = fixture('fal-ai/bytedance/seed/v2/mini')
    expect(falChatFacts({ endpoint_id: model.endpoint_id }, LISTING)).toEqual(
      {},
    )
  })

  it('stores nothing when the schema is reworded', () => {
    const model = fixture('fal-ai/bytedance/seed/v2/mini')
    const properties = inputProperties(model)
    // The cap moves into prose, the toggle changes vocabulary.
    delete properties.max_completion_tokens?.maximum
    properties.thinking!.enum = ['on', 'off']
    model.metadata.description = 'Up to 256,000 tokens of context.'
    const got = facts(model)
    expect(got.maxOutput).toBeUndefined()
    expect(got.reasoning).toBeUndefined()
    expect(got.capabilities).not.toContain('reasoning')
    expect(got.contextWindow).toBeUndefined()
  })

  it('does not read a non-integer or unbounded cap', () => {
    const model = fixture('nvidia/nemotron-3-nano-omni/vision')
    inputProperties(model).max_tokens!.type = 'string'
    expect(facts(model).maxOutput).toBeUndefined()
    const other = fixture('nvidia/nemotron-3-nano-omni/vision')
    inputProperties(other).max_tokens!.maximum = '20000'
    expect(facts(other).maxOutput).toBeUndefined()
  })

  it('marks reasoning mandatory when it cannot be disabled', () => {
    const model = fixture('fal-ai/bytedance/seed/v2/mini')
    inputProperties(model).thinking!.enum = ['enabled', 'auto']
    expect(facts(model).reasoning?.mandatory).toBe(true)
  })
})

describe('falDescriptionContextWindow', () => {
  it('reads one stated size', () => {
    expect(falDescriptionContextWindow('video input with 256K context')).toBe(
      256_000,
    )
    expect(falDescriptionContextWindow('a 1M context model')).toBe(1_000_000)
  })

  it('refuses anything else', () => {
    for (const text of [
      undefined,
      '',
      'long-context reasoning model',
      'provide context to the model',
      'from 128K context to 256K context',
      '256K tokens',
      '256 context',
      'renders 4K video',
    ]) {
      expect(falDescriptionContextWindow(text), String(text)).toBeNull()
    }
  })
})

describe('fal listModels', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const image = {
    endpoint_id: 'fal-ai/flux/dev',
    metadata: { category: 'text-to-image' },
  }
  const listed = fixtures.map(({ endpoint_id, metadata }) => ({
    endpoint_id,
    metadata,
  }))

  function page(models: Array<unknown>): Response {
    return new Response(
      JSON.stringify({ models, has_more: false, next_cursor: null }),
    )
  }

  it('fills chat rows from one spec request by endpoint id', async () => {
    const urls: Array<URL> = []
    vi.stubGlobal('fetch', (input: string) => {
      const url = new URL(input)
      urls.push(url)
      return Promise.resolve(
        url.searchParams.has('endpoint_id')
          ? page(fixtures)
          : page([image, ...listed]),
      )
    })
    const { models } = await falProvider.listModels({ FAL_KEY: 'k' })
    expect(urls).toHaveLength(2)
    expect(urls[0]?.searchParams.has('expand')).toBe(false)
    expect(urls[1]?.searchParams.get('expand')).toBe('openapi-3.0')
    expect(urls[1]?.searchParams.getAll('endpoint_id').sort()).toEqual(
      fixtures.map((m) => m.endpoint_id).sort(),
    )
    const byId = new Map(models.map((m) => [m.rawId, m]))
    expect(byId.get('fal-ai/flux/dev')).toMatchObject({
      activity: 'image',
      capabilities: { category: 'text-to-image' },
    })
    expect(byId.get('fal-ai/flux/dev')?.factSources).toBeUndefined()
    expect(byId.get('fal-ai/bytedance/seed/v2/mini')).toMatchObject({
      activity: 'chat',
      contextWindow: 256_000,
      maxOutput: 65_536,
    })
    // No request schema: the row keeps FAL's category object.
    expect(
      byId.get('openrouter/router/openai/v1/chat/completions')?.capabilities,
    ).toEqual({ category: 'llm' })
  })

  it('lists every row and withholds chat facts when a chat spec is missing', async () => {
    vi.stubGlobal('fetch', (input: string) =>
      Promise.resolve(
        new URL(input).searchParams.has('endpoint_id')
          ? page(fixtures.slice(1))
          : page([image, ...listed]),
      ),
    )
    const result = await falProvider.listModels({ FAL_KEY: 'k' })
    expect(result.docsFailures?.first).toMatchObject([
      {
        source:
          'https://api.fal.ai/v1/models?expand=openapi-3.0 (chat endpoints)',
        error: expect.stringContaining(
          'fal chat specs: models API left out',
        ) as string,
      },
    ])
    expect(result.models).toHaveLength(listed.length + 1)
    for (const model of result.models) {
      if (model.activity === 'chat') {
        expect(model.absent).toEqual({
          contextWindow: 'unavailable',
          maxOutput: 'unavailable',
          modalities: 'unavailable',
          capabilities: 'unavailable',
          reasoning: 'unavailable',
        })
      } else {
        expect(model.absent).toBeUndefined()
      }
    }
  })

  it('fails the poll when the listing itself fails', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(new Response('denied', { status: 401 })),
    )
    await expect(falProvider.listModels({ FAL_KEY: 'k' })).rejects.toThrow()
  })
})
