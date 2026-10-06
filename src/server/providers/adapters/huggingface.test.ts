import { readFileSync } from 'node:fs'

import { afterEach, describe, expect, it } from 'vitest'

import { classifyAndBundle } from '#/server/ingest/sync.ts'

import {
  buildHuggingFaceSpec,
  HUGGINGFACE_MODELS_URL,
  HUGGINGFACE_SPEC_RAW_URL,
  parseHuggingFaceModels,
  provider,
} from './huggingface.ts'

const fixture = (name: string) =>
  readFileSync(
    new URL(
      `../fixtures/huggingface-chat-completion-${name}.json`,
      import.meta.url,
    ),
    'utf8',
  )
/** huggingface.js `chat-completion/spec/{input,output}.json` (2026-10-06). */
const INPUT = fixture('input')
const OUTPUT = fixture('output')

const host = (name: string, rest: Record<string, unknown>) => ({
  provider: name,
  status: 'live',
  is_free: false,
  is_model_author: false,
  ...rest,
})
/** featherless-ai is live but publishes no figures. */
const SILENT = host('featherless-ai', {})

const model = (id: string, providers: unknown, output = ['text']) => ({
  id,
  created: 1785918179,
  architecture: { input_modalities: ['text'], output_modalities: output },
  providers,
})

/** Rows shaped like https://router.huggingface.co/v1/models (2026-10-06). */
const FIXTURE = {
  object: 'list',
  data: [
    model('agree/all', [
      host('nscale', {
        context_length: 40960,
        pricing: { input: 0.07, output: 0.2 },
        supports_tools: true,
        supports_structured_output: false,
        throughput: 79.9,
      }),
      host('deepinfra', {
        context_length: 40960,
        pricing: { input: 0.07, output: 0.2 },
        supports_tools: true,
        supports_structured_output: false,
        throughput: 15.2,
      }),
    ]),
    // A provider that states nothing settles nothing, not even a "no".
    model('agree/but-one-silent', [
      host('nscale', {
        context_length: 40960,
        pricing: { input: 0.07, output: 0.2 },
        supports_tools: false,
        supports_structured_output: false,
        throughput: 79.9,
      }),
      SILENT,
    ]),
    // deepseek-ai/DeepSeek-V4.1-Flash: same context, structured output split.
    model('split/price', [
      host('novita', {
        context_length: 1048576,
        pricing: { input: 0.3, output: 1.2 },
        supports_tools: true,
        supports_structured_output: false,
        throughput: 102.2,
      }),
      host('fireworks-ai', {
        context_length: 1048576,
        supports_tools: true,
        supports_structured_output: true,
        throughput: 126.4,
      }),
      host('deepinfra', {
        context_length: 1048576,
        pricing: { input: 0.2, output: 0.6 },
        supports_tools: true,
        supports_structured_output: true,
        throughput: 106,
      }),
    ]),
    model('split/context', [
      host('novita', {
        context_length: 1000000,
        pricing: { input: 0.42, output: 3 },
        supports_tools: true,
        supports_structured_output: true,
        throughput: 39,
      }),
      host('cerebras', {
        context_length: 65536,
        pricing: { input: 0.42, output: 3 },
        supports_tools: true,
        supports_structured_output: true,
        throughput: 172,
      }),
    ]),
    model('unranked/only', [SILENT]),
    model('settled/no', [
      host('novita', {
        context_length: 8192,
        pricing: { input: 0.1, output: 0.2 },
        supports_tools: false,
        supports_structured_output: false,
        throughput: 50,
      }),
    ]),
    model('image/model', [], ['image']),
  ],
}

const listing = { derivation: 'listing', sourceUrl: HUGGINGFACE_MODELS_URL }

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('huggingface listing', () => {
  it('stores a fact only when every provider states it and agrees', () => {
    const models = parseHuggingFaceModels(FIXTURE)
    const byId = Object.fromEntries(models.map((m) => [m.rawId, m]))

    // No row carries a price, agreed or not: the poller would keep it
    // after the providers stop agreeing.
    for (const row of models) {
      expect(row.pricing).toBeNull()
      expect(row.factSources).not.toHaveProperty('pricing')
    }

    expect(byId['agree/all']).toMatchObject({
      activity: 'chat',
      contextWindow: 40960,
      capabilities: ['tools'],
    })
    expect(byId['agree/all']?.factSources).toEqual({
      contextWindow: { ...listing, path: 'providers[].context_length' },
      capabilities: {
        tools: { ...listing, path: 'providers[].supports_tools' },
      },
    })

    expect(byId['agree/but-one-silent']).toMatchObject({
      contextWindow: null,
      capabilities: null,
      factSources: {},
    })

    expect(byId['split/price']).toMatchObject({
      contextWindow: 1048576,
      capabilities: null,
    })
    expect(byId['split/price']?.factSources).toEqual({
      contextWindow: { ...listing, path: 'providers[].context_length' },
    })

    expect(byId['split/context']).toMatchObject({
      contextWindow: null,
      capabilities: ['tools', 'structured_outputs', 'response_format'],
    })

    expect(byId['unranked/only']).toMatchObject({
      contextWindow: null,
      capabilities: null,
      factSources: {},
    })
    // Settled "no" flags are an empty list.
    expect(byId['settled/no']).toMatchObject({
      contextWindow: 8192,
      capabilities: [],
    })
    expect(byId['image/model']).toMatchObject({ activity: 'image' })
  })

  it('settles nothing from a reshaped providers list', () => {
    const ranked = host('nscale', {
      context_length: 40960,
      pricing: { input: 0.07, output: 0.2 },
      supports_tools: true,
      supports_structured_output: true,
      throughput: 79.9,
    })
    const reshaped = [
      { nscale: ranked },
      [ranked, 'featherless-ai'],
      [
        {
          ...ranked,
          context_length: '40960',
          pricing: { prompt: 0.07, completion: 0.2 },
          supports_tools: 'yes',
        },
      ],
    ]
    for (const providers of reshaped) {
      const [row] = parseHuggingFaceModels({
        data: [model('x/y', providers)],
      })
      expect(row).toMatchObject({
        contextWindow: null,
        pricing: null,
        capabilities: null,
        factSources: {},
      })
    }
  })

  it('throws on a payload that lists nothing', () => {
    expect(() => parseHuggingFaceModels({ data: [] })).toThrow('listed no ids')
    expect(() => parseHuggingFaceModels('<html>')).toThrow('no data array')
  })
})

describe('huggingface spec', () => {
  it('wraps the published schemas into one chat path', () => {
    const spec = buildHuggingFaceSpec(INPUT, OUTPUT)
    expect(Object.keys(spec.paths ?? {})).toEqual(['/v1/chat/completions'])
    expect(JSON.stringify(spec)).not.toContain('#/$defs/')

    const { endpoints, warnings } = classifyAndBundle(provider, {
      specs: [spec],
      sources: [{ url: 'x', hash: 'y' }],
      outputStrategy: 'post-200',
    })
    expect(endpoints).toHaveLength(1)
    const [endpoint] = endpoints
    expect(endpoint).toMatchObject({
      activity: 'chat',
      derivation: 'generated',
    })
    expect(warnings).toEqual([])
    expect(Object.keys(endpoint?.input?.$defs ?? {})).toHaveLength(16)
    expect(endpoint?.output).toBeDefined()
    expect(
      provider.generationEndpointId?.({ rawId: 'a/b', activity: 'chat' }),
    ).toBe('v1/chat/completions')
    expect(
      provider.generationEndpointId?.({ rawId: 'a/b', activity: 'image' }),
    ).toBeNull()
  })

  it('throws on a file that is not the published schema', () => {
    const renamed = INPUT.replace('"ChatCompletionInput"', '"ChatInput"')
    const noMessages = INPUT.replace('"messages": {', '"msgs": {')
    for (const [input, output] of [
      ['<!doctype html><title>Not found</title>', OUTPUT],
      [INPUT, '{}'],
      [renamed, OUTPUT],
      [noMessages, OUTPUT],
      [INPUT, INPUT],
    ]) {
      expect(() => buildHuggingFaceSpec(input ?? '', output ?? '')).toThrow(
        /^huggingface: /,
      )
    }
  })

  it('throws on an HTML body served for either schema file', () => {
    const html = '<!doctype html><html><body>Not found</body></html>'
    expect(() => buildHuggingFaceSpec(html, OUTPUT)).toThrow('is not JSON')
    expect(() => buildHuggingFaceSpec(INPUT, html)).toThrow('is not JSON')
  })

  it('fetches the listing and both schema files', async () => {
    const urls: Array<string> = []
    globalThis.fetch = ((url: string) => {
      urls.push(String(url))
      const body: Record<string, string> = {
        [HUGGINGFACE_MODELS_URL]: JSON.stringify(FIXTURE),
        [`${HUGGINGFACE_SPEC_RAW_URL}/input.json`]: INPUT,
        [`${HUGGINGFACE_SPEC_RAW_URL}/output.json`]: OUTPUT,
      }
      const text = body[String(url)]
      return text === undefined
        ? Promise.reject(new Error(`unexpected fetch: ${String(url)}`))
        : Promise.resolve(new Response(text))
    }) as typeof fetch

    const listed = await provider.listModels({})
    const spec = await provider.fetchSpec({})

    expect(listed.models).toHaveLength(FIXTURE.data.length)
    expect(spec.specs).toHaveLength(1)
    expect(spec.sources[0]?.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(urls).toHaveLength(3)
  })
})
