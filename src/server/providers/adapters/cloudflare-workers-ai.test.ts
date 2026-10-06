import { afterEach, describe, expect, it } from 'vitest'

import gptOss from '../fixtures/workers-ai-gpt-oss-120b.json'
import {
  catalogFacts,
  chatBodyFields,
  parseCatalogModel,
  provider,
  thinkingSwitch,
  WORKERS_AI_CATALOG_URL,
  WORKERS_AI_MODELS_URL,
} from './cloudflare-workers-ai.ts'
import type { CatalogDoc } from './cloudflare-workers-ai.ts'

/** Excerpt of developers.cloudflare.com/workers-ai/models/ (2026-10-07). */
const GLM_CARD = `<div data-model-id="@cf/zai-org/glm-5.3" data-model-label="glm-5.3" data-model-href="/workers-ai/models/glm-5.3/" data-model-task="Text Generation" data-model-context="1048576" data-model-pricing="Input (per 1M tokens): $1.40
Output (per 1M tokens): $4.40
Cached input (per 1M tokens): $0.26"></div>`
const APERTUS_CARD = `<div data-model-id="@cf/swiss-ai/apertus-v1.5-8b" data-model-label="apertus-v1.5-8b" data-model-href="/workers-ai/models/apertus-v1.5-8b/" data-model-task="Text Generation" data-model-context="262144" data-model-output data-model-pricing></div>`
const OTHER_CARDS = `<div data-model-id="@cf/deepgram/aura-1" data-model-label="aura-1" data-model-href="/workers-ai/models/aura-1/" data-model-task="Text-to-Speech" data-model-pricing="per 1k characters: $0.015"></div>
<div data-model-id="@cf/black-forest-labs/flux-1-schnell" data-model-label="flux-1-schnell" data-model-task="Text-to-Image"></div>`
const FIXTURE = [GLM_CARD, APERTUS_CARD, OTHER_CARDS].join('\n')

const GLM_URL = `${WORKERS_AI_CATALOG_URL}glm-5.3.json`
const APERTUS_URL = `${WORKERS_AI_CATALOG_URL}apertus-v1.5-8b.json`

/** The two chat-completions request shapes Cloudflare's files use. */
const body = (...fields: Array<string>) => ({
  properties: Object.fromEntries(fields.map((name) => [name, {}])),
})
const LEGACY_INPUT = {
  type: 'object',
  oneOf: [
    { title: 'Prompt', ...body('prompt', 'max_tokens') },
    { title: 'Messages', ...body('messages', 'tools', 'max_tokens') },
  ],
}
const effortInput = (efforts: Array<string>) => ({
  anyOf: [
    {
      oneOf: [
        { title: 'Prompt', ...body('prompt', 'max_tokens') },
        {
          title: 'Messages',
          properties: {
            messages: {},
            max_tokens: {},
            max_completion_tokens: {},
            reasoning_effort: {
              anyOf: [{ type: 'string', enum: efforts }, { type: 'null' }],
            },
          },
        },
      ],
    },
    { ...body('requests') },
  ],
})

/** `properties` are verbatim from Cloudflare's files; schemas are cut down. */
function catalogFile(
  name: string,
  properties: Array<{ property_id: string; value: unknown }>,
  schema?: { input: unknown; output?: unknown },
): string {
  return JSON.stringify({
    name,
    task: { name: 'Text Generation' },
    properties,
    ...(schema ? { schema } : {}),
  })
}

const GLM_PROPERTIES = [
  { property_id: 'require_workers_paid', value: 'true' },
  { property_id: 'context_window', value: '1048576' },
  { property_id: 'function_calling', value: 'true' },
  { property_id: 'reasoning', value: 'true' },
  {
    property_id: 'reasoning_effort',
    value: {
      supported_efforts: ['max', 'high', 'low'],
      default_effort: 'max',
      normalizes_to: { none: 'max', minimal: 'max', medium: 'max' },
      mandatory: true,
      default_enabled: true,
    },
  },
]
const GLM = catalogFile('@cf/zai-org/glm-5.3', GLM_PROPERTIES, {
  input: effortInput(['max', 'high', 'low']),
  output: { type: 'object', properties: { choices: { type: 'array' } } },
})
const APERTUS = catalogFile('@cf/swiss-ai/apertus-v1.5-8b', [
  { property_id: 'context_window', value: '262144' },
  { property_id: 'function_calling', value: 'true' },
  { property_id: 'vision', value: 'true' },
])

function facts(text: string, rawId: string, edit?: (doc: CatalogDoc) => void) {
  const url = `${WORKERS_AI_CATALOG_URL}x.json`
  const parsed = parseCatalogModel(text, rawId, url)
  const doc: CatalogDoc = {
    properties: parsed.properties,
    chatFields: chatBodyFields(parsed.input),
    thinkingSwitch: thinkingSwitch(parsed.input),
    hasRequestSchema: parsed.input !== null,
    hash: 'h',
  }
  edit?.(doc)
  return catalogFacts(doc, rawId, url)
}

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function stubFetch(pages: Record<string, string>): Array<string> {
  const urls: Array<string> = []
  globalThis.fetch = ((url: string) => {
    urls.push(String(url))
    const page = pages[String(url)]
    return Promise.resolve(
      page === undefined
        ? new Response('<html>Not found</html>', { status: 404 })
        : new Response(page),
    )
  }) as typeof fetch
  return urls
}

describe('cloudflare-workers-ai listing', () => {
  it('lists catalog cards and prices only per-1M input and output', async () => {
    const urls = stubFetch({
      [WORKERS_AI_MODELS_URL]: FIXTURE,
      [GLM_URL]: GLM,
      [APERTUS_URL]: APERTUS,
    })

    const listed = await provider.listModels({})
    const glm = listed.models.find(
      (model) => model.rawId === '@cf/zai-org/glm-5.3',
    )
    const aura = listed.models.find(
      (model) => model.rawId === '@cf/deepgram/aura-1',
    )

    expect(listed.models.map((model) => model.rawId)).toEqual([
      '@cf/zai-org/glm-5.3',
      '@cf/swiss-ai/apertus-v1.5-8b',
      '@cf/deepgram/aura-1',
      '@cf/black-forest-labs/flux-1-schnell',
    ])
    expect(glm).toMatchObject({
      activity: 'chat',
      contextWindow: 1048576,
      displayName: 'glm-5.3',
      capabilities: ['tools', 'reasoning'],
      schemaEndpointId: 'accounts/{account_id}/ai/run/@cf/zai-org/glm-5.3',
    })
    expect(glm).not.toHaveProperty('catalogUrl')
    expect(glm?.pricing).toMatchObject({
      tables: {
        rate: {
          base: {
            input_tokens: 1.4 / 1_000_000,
            output_tokens: 4.4 / 1_000_000,
            cache_read_tokens: 0.26 / 1_000_000,
          },
        },
      },
    })
    // Only text-generation cards read a catalog file.
    expect(aura).toEqual({
      rawId: '@cf/deepgram/aura-1',
      displayName: 'aura-1',
      activity: 'audio',
      contextWindow: null,
      pricing: null,
    })
    expect(listed.models[3]).toMatchObject({ activity: 'image', pricing: null })
    expect(urls.sort()).toEqual(
      [WORKERS_AI_MODELS_URL, GLM_URL, APERTUS_URL].sort(),
    )
  })

  it('withholds only that model’s catalog facts when one file cannot be read', async () => {
    // A 404, a 200 that is an HTML page, and a 200 that is another model's file.
    const unreadable: Array<[string | undefined, RegExp]> = [
      [undefined, /apertus.*404/],
      ['<!doctype html><title>Sign in</title>', /is not JSON/],
      [GLM, /is not the catalog file for @cf\/swiss-ai\/apertus-v1.5-8b/],
    ]
    for (const [apertus, error] of unreadable) {
      stubFetch({
        [WORKERS_AI_MODELS_URL]: FIXTURE,
        [GLM_URL]: GLM,
        ...(apertus === undefined ? {} : { [APERTUS_URL]: apertus }),
      })
      const listed = await provider.listModels({})
      expect(listed.docsFailures?.first).toMatchObject([
        { source: APERTUS_URL, error: expect.stringMatching(error) as string },
      ])
      const [glm, failed] = listed.models
      // The listing page's own facts and the other model's file still land.
      expect(glm).toMatchObject({ capabilities: ['tools', 'reasoning'] })
      expect(glm?.absent).toBeUndefined()
      expect(glm?.pricing).not.toBeNull()
      expect(failed).toMatchObject({
        rawId: '@cf/swiss-ai/apertus-v1.5-8b',
        activity: 'chat',
        absent: {
          modalities: 'unavailable',
          capabilities: 'unavailable',
          reasoning: 'unavailable',
          requestMap: 'unavailable',
          schemaEndpointId: 'unavailable',
        },
      })
      expect(failed).not.toHaveProperty('capabilities')
    }
  })

  it('fails when a text-generation card links no model page', async () => {
    stubFetch({
      [WORKERS_AI_MODELS_URL]:
        '<div data-model-id="@cf/a/b" data-model-href="https://example.com/b/" data-model-task="Text Generation"></div>',
    })
    await expect(provider.listModels({})).rejects.toThrow(
      /@cf\/a\/b links no model page/,
    )
  })
})

describe('cloudflare-workers-ai catalog facts', () => {
  it('reads efforts, flags, and the request map from an effort model', () => {
    const glm = facts(GLM, '@cf/zai-org/glm-5.3')
    expect(glm).toMatchObject({
      modalities: { input: ['text'], output: ['text'] },
      capabilities: ['tools', 'reasoning'],
      exactCapabilities: true,
      reasoning: {
        mode: 'effort',
        mandatory: true,
        efforts: ['max', 'high', 'low'],
      },
      requestMap: {
        thinking: {
          on: { reasoning_effort: 'high' },
          off: null,
          levels: {
            off: null,
            minimal: null,
            low: 'low',
            medium: null,
            high: 'high',
            xhigh: null,
            max: 'max',
          },
        },
        maxTokensField: 'max_completion_tokens',
        developerRole: null,
        reasoningEffort: true,
      },
    })
    expect(glm.factSources).toMatchObject({
      modalities: { sourceUrl: `${WORKERS_AI_CATALOG_URL}x.json` },
      capabilities: {
        tools: { derivation: 'listing', path: 'properties.function_calling' },
        reasoning: { path: 'properties.reasoning' },
      },
      reasoning: { sourceHash: 'h', path: 'properties.reasoning_effort' },
    })
  })

  it('maps a "none" effort to an explicit off', () => {
    const kimi = facts(
      catalogFile(
        '@cf/moonshotai/kimi-k2.6',
        [
          { property_id: 'reasoning', value: 'true' },
          {
            property_id: 'reasoning_effort',
            value: {
              supported_efforts: ['high', 'none'],
              default_effort: 'high',
              mandatory: false,
              default_enabled: true,
            },
          },
          { property_id: 'vision', value: 'true' },
        ],
        { input: effortInput(['high', 'none']) },
      ),
      '@cf/moonshotai/kimi-k2.6',
    )
    expect(kimi.modalities).toEqual({
      input: ['text', 'image'],
      output: ['text'],
    })
    expect(kimi.reasoning).toEqual({
      mode: 'effort',
      mandatory: false,
      efforts: ['high', 'none'],
    })
    expect(kimi.requestMap?.thinking).toMatchObject({
      off: { reasoning_effort: 'none' },
      levels: { off: 'none', high: 'high', max: null },
    })
  })

  /** A chat body with `chat_template_kwargs.enable_thinking`, as published. */
  const switchInput = (enableThinking: unknown) => ({
    anyOf: [
      {
        oneOf: [
          { title: 'Prompt', ...body('prompt', 'max_tokens') },
          {
            title: 'Messages',
            properties: {
              messages: {},
              max_tokens: {},
              max_completion_tokens: {},
              chat_template_kwargs: {
                type: 'object',
                properties: {
                  enable_thinking: enableThinking,
                  clear_thinking: { type: 'boolean', default: false },
                },
              },
            },
          },
        ],
      },
      { ...body('requests') },
    ],
  })
  /** `enable_thinking` of gemma-4-26b-a4b-it and of kimi-k2.7-code (2026-10-07). */
  const ON_OFF = {
    type: 'boolean',
    default: true,
    description: 'Whether to enable reasoning for this model.',
  }
  const ON_ONLY = {
    type: 'boolean',
    default: true,
    description:
      'Reasoning is always enabled for this model and cannot be disabled.',
    enum: [true],
  }
  const switched = (
    rawId: string,
    effort: unknown,
    enableThinking: unknown,
    edit?: (doc: CatalogDoc) => void,
  ) =>
    facts(
      catalogFile(
        rawId,
        [
          { property_id: 'reasoning', value: 'true' },
          ...(effort === undefined
            ? []
            : [{ property_id: 'reasoning_effort', value: effort }]),
        ],
        { input: switchInput(enableThinking) },
      ),
      rawId,
      edit,
    )

  it('reads an on/off toggle from the model’s own enable_thinking field', () => {
    // On by default, can be turned off.
    const gemma = switched(
      '@cf/google/gemma-4-26b-a4b-it',
      { mandatory: false, default_enabled: true },
      ON_OFF,
    )
    expect(gemma.reasoning).toEqual({ mode: 'toggle', mandatory: false })
    expect(gemma.capabilities).toEqual(['reasoning'])
    expect(gemma.factSources?.reasoning).toMatchObject({
      sourceHash: 'h',
      path: 'chat_template_kwargs.enable_thinking',
    })
    // The request map is unchanged by the toggle.
    expect(gemma.requestMap).toMatchObject({
      thinking: null,
      maxTokensField: 'max_completion_tokens',
      reasoningEffort: null,
    })

    // The catalog states `mandatory: true`, and the field only takes `true`.
    expect(
      switched(
        '@cf/moonshotai/kimi-k2.7-code',
        { mandatory: true, default_enabled: true },
        ON_ONLY,
      ).reasoning,
    ).toEqual({ mode: 'toggle', mandatory: true })
    // The statement wins over a field that still offers `false`.
    expect(
      switched('@cf/moonshotai/kimi-k2.7-code', { mandatory: true }, ON_OFF)
        .reasoning,
    ).toEqual({ mode: 'toggle', mandatory: true })
    // @cf/nvidia/nemotron-3-120b-a12b: no property, a plain boolean field.
    expect(
      switched('@cf/nvidia/nemotron-3-120b-a12b', undefined, ON_OFF).reasoning,
    ).toEqual({ mode: 'toggle', mandatory: false })
  })

  it('stores no toggle without a request field or a stated off position', () => {
    const none = (model: ReturnType<typeof facts>) => {
      expect(model.reasoning).toBeUndefined()
      expect(model.capabilities).toEqual(['reasoning'])
      expect(model.factSources?.reasoning?.path).toBe('silent')
    }
    // @cf/qwen/qwq-32b: the catalog flag alone.
    none(
      facts(
        catalogFile(
          '@cf/qwen/qwq-32b',
          [{ property_id: 'reasoning', value: 'true' }],
          { input: body('messages', 'max_tokens') },
        ),
        '@cf/qwen/qwq-32b',
      ),
    )
    // `mandatory` is stated but the request takes no switch.
    none(
      facts(
        catalogFile(
          '@cf/x/y',
          [
            { property_id: 'reasoning', value: 'true' },
            { property_id: 'reasoning_effort', value: { mandatory: true } },
          ],
          { input: body('messages', 'max_tokens') },
        ),
        '@cf/x/y',
      ),
    )
    // A field that only takes `true`, with no statement beside it.
    none(switched('@cf/x/y', undefined, ON_ONLY))
    // The catalog says it can be turned off; the field refuses `false`.
    none(switched('@cf/x/y', { mandatory: false }, ON_ONLY))
    // Shapes this does not know.
    none(switched('@cf/x/y', undefined, { type: 'string', enum: ['on'] }))
    none(switched('@cf/x/y', undefined, { ...ON_OFF, enum: [false] }))
    none(switched('@cf/x/y', undefined, {}))
    // An entry cached before the field was read claims no switch.
    none(
      switched('@cf/x/y', { mandatory: false }, ON_OFF, (doc) => {
        delete doc.thinkingSwitch
      }),
    )
    // A `mandatory` that is not a boolean is a changed file.
    expect(() => switched('@cf/x/y', { mandatory: 'no' }, ON_OFF)).toThrow(
      /reasoning_effort changed shape/,
    )
  })

  it('reads enable_thinking only from bodies that take messages', () => {
    expect(thinkingSwitch(switchInput(ON_OFF))).toBe('on-off')
    expect(thinkingSwitch(switchInput(ON_ONLY))).toBe('on-only')
    expect(thinkingSwitch(effortInput(['low']))).toBeNull()
    expect(thinkingSwitch(null)).toBeNull()
    const kwargs = (field: unknown) => ({
      chat_template_kwargs: { properties: { enable_thinking: field } },
    })
    // A prompt body's switch is not the chat body's.
    expect(
      thinkingSwitch({
        oneOf: [{ properties: { prompt: {}, ...kwargs(ON_OFF) } }],
      }),
    ).toBeNull()
    // Two chat bodies that disagree state nothing.
    expect(
      thinkingSwitch({
        oneOf: [
          { properties: { messages: {}, ...kwargs(ON_OFF) } },
          { properties: { messages: {}, ...kwargs(ON_ONLY) } },
        ],
      }),
    ).toBeNull()
  })

  it('reads chat fields only from bodies that take messages', () => {
    // The whole file as published: its Responses body has `reasoning`, its
    // chat body has neither that nor `reasoning_effort`.
    const text = JSON.stringify(gptOss)
    const parsed = parseCatalogModel(text, '@cf/openai/gpt-oss-120b', 'u')
    const fields = chatBodyFields(parsed.input)
    expect(fields).toContain('messages')
    expect(fields).toContain('max_tokens')
    expect(fields).not.toContain('reasoning')
    expect(fields).not.toContain('input')
    expect(fields).not.toContain('prompt')

    const oss = facts(text, '@cf/openai/gpt-oss-120b')
    expect(oss.reasoning).toEqual({
      mode: 'effort',
      mandatory: true,
      efforts: ['low', 'medium', 'high'],
    })
    expect(oss.requestMap).toMatchObject({
      thinking: null,
      maxTokensField: 'max_tokens',
      reasoningEffort: null,
    })
    expect(oss.schemaEndpointId).toBe(
      'accounts/{account_id}/ai/run/@cf/openai/gpt-oss-120b',
    )
  })

  it('gives no "effort high" body to a model without that level', () => {
    // @cf/qwen/qwen3.8-27b
    const qwen = facts(
      catalogFile(
        '@cf/qwen/qwen3.8-27b',
        [
          {
            property_id: 'reasoning_effort',
            value: {
              supported_efforts: ['low', 'medium', 'xhigh'],
              mandatory: false,
            },
          },
        ],
        { input: effortInput(['low', 'medium', 'xhigh']) },
      ),
      '@cf/qwen/qwen3.8-27b',
    )
    expect(qwen.requestMap).toMatchObject({
      thinking: null,
      reasoningEffort: true,
    })
  })

  it('claims nothing the file does not state', () => {
    // No properties beyond the window: an empty, exact flag list.
    const llama = facts(
      catalogFile(
        '@cf/meta/llama-3.2-1b-instruct',
        [{ property_id: 'context_window', value: '60000' }],
        { input: LEGACY_INPUT },
      ),
      '@cf/meta/llama-3.2-1b-instruct',
    )
    expect(llama.capabilities).toEqual([])
    expect(llama.exactCapabilities).toBe(true)
    expect(llama.reasoning).toBeUndefined()
    expect(Object.keys(llama.factSources ?? {})).toEqual([
      'modalities',
      'capabilities',
    ])
    expect(llama.factSources?.capabilities).toEqual({})

    // No schema: no route to bind and no request map.
    const apertus = facts(APERTUS, '@cf/swiss-ai/apertus-v1.5-8b')
    expect(apertus.schemaEndpointId).toBeUndefined()
    expect(apertus.requestMap).toBeUndefined()
    expect(apertus.capabilities).toEqual(['tools'])

    // A schema that is not a chat body (@cf/cloudflare/clef): a route, but
    // no chat request map.
    const clef = facts(
      catalogFile('@cf/cloudflare/clef', [], {
        input: { type: 'object', ...body('model', 'state', 'questions') },
      }),
      '@cf/cloudflare/clef',
    )
    expect(clef.requestMap).toBeUndefined()
    expect(clef.schemaEndpointId).toBe(
      'accounts/{account_id}/ai/run/@cf/cloudflare/clef',
    )
  })

  it('throws on a property that changed shape', () => {
    const mutate = (id: string, value: unknown) => () =>
      facts(GLM, '@cf/zai-org/glm-5.3', (doc) => {
        doc.properties[id] = value
      })
    expect(mutate('function_calling', 'yes')).toThrow(/function_calling/)
    expect(mutate('vision', true)).toThrow(/vision/)
    expect(mutate('reasoning', 'high')).toThrow(/reasoning changed shape/)
    expect(mutate('reasoning_effort', 'high')).toThrow(/reasoning_effort/)
    expect(mutate('reasoning_effort', { supported_efforts: 'high' })).toThrow(
      /reasoning_effort/,
    )
    expect(
      mutate('reasoning_effort', { supported_efforts: [], mandatory: true }),
    ).toThrow(/reasoning_effort/)
    // Efforts without a stated `mandatory` are not defaulted to optional.
    expect(
      mutate('reasoning_effort', { supported_efforts: ['low', 'high'] }),
    ).toThrow(/reasoning_effort/)
  })

  it('throws on a file that is not a catalog file', () => {
    const parse = (text: string) => () =>
      parseCatalogModel(text, '@cf/zai-org/glm-5.3', 'u')
    expect(parse('[]')).toThrow(/is not the catalog file/)
    expect(parse('{"name":"@cf/zai-org/glm-5.3"}')).toThrow(
      /has no properties list/,
    )
    expect(
      parse('{"name":"@cf/zai-org/glm-5.3","properties":[{"id":"x"}]}'),
    ).toThrow(/malformed property/)
  })
})

describe('cloudflare-workers-ai spec', () => {
  it('builds one document per model that publishes a request schema', async () => {
    stubFetch({
      [WORKERS_AI_MODELS_URL]: FIXTURE,
      [GLM_URL]: GLM,
      [APERTUS_URL]: APERTUS,
    })
    const spec = await provider.fetchSpec({})
    const path = '/accounts/{account_id}/ai/run/@cf/zai-org/glm-5.3'

    expect(spec.skipped).toBeUndefined()
    expect(spec.specs).toHaveLength(1)
    expect(spec.sources.map((source) => source.url)).toEqual([GLM_URL])
    expect(spec.sources[0]?.hash).toMatch(/^[0-9a-f]{64}$/)
    const post = spec.specs[0]?.paths?.[path]?.post as {
      requestBody: { content: Record<string, { schema: unknown }> }
      responses: Record<
        string,
        { content: Record<string, { schema: unknown }> }
      >
    }
    expect(post.requestBody.content['application/json']?.schema).toEqual(
      effortInput(['max', 'high', 'low']),
    )
    expect(
      post.responses['200']?.content['application/json']?.schema,
    ).toMatchObject({ type: 'object' })
    expect(provider.classify(path, {})).toBe('chat')
    expect(provider.classify('/accounts/{account_id}/ai/models', {})).toBeNull()
  })

  it('throws when no model publishes a schema or a file is unreadable', async () => {
    stubFetch({ [WORKERS_AI_MODELS_URL]: APERTUS_CARD, [APERTUS_URL]: APERTUS })
    await expect(provider.fetchSpec({})).rejects.toThrow(
      /no text-generation model published a request schema/,
    )

    stubFetch({ [WORKERS_AI_MODELS_URL]: FIXTURE, [GLM_URL]: GLM })
    await expect(provider.fetchSpec({})).rejects.toThrow(/404/)
  })
})
