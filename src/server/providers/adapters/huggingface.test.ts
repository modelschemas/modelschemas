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
/** featherless-ai is live but publishes no figures, so it is not `:fastest`. */
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
    // An unprobed host is not the default route and does not veto it.
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
    // inclusionAI/Ling-3.0-flash and tencent/Hy4-preview: the same price
    // with float noise on one side.
    model('agree/float-noise', [
      host('novita', {
        context_length: 131072,
        pricing: { input: 0.06, output: 2.501 },
        supports_tools: true,
        supports_structured_output: true,
        throughput: 60,
      }),
      host('deepinfra', {
        context_length: 131072,
        pricing: { input: 0.060000000000000005, output: 2.5010000000000003 },
        supports_tools: true,
        supports_structured_output: true,
      }),
    ]),
    // ibm-granite/granite-4.2-3b: one provider, noisy figures.
    model('single/float-noise', [
      host('deepinfra', {
        context_length: 131072,
        pricing: { input: 0.030000000000000002, output: 0.12000000000000001 },
        supports_tools: true,
        supports_structured_output: true,
        throughput: 60,
      }),
    ]),
    // deepseek-ai/DeepSeek-V4.1-Flash: same context, different prices, one
    // provider with no price, structured output split.
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
    model('promo/free', [
      host('novita', {
        context_length: 8192,
        pricing: { input: 0.1, output: 0.2 },
        is_free: true,
        supports_tools: false,
        supports_structured_output: false,
        throughput: 50,
      }),
    ]),
    // Same throughput: context is shared, the prices are not.
    model('route/tie', [
      host('novita', {
        context_length: 4096,
        pricing: { input: 0.2, output: 0.4 },
        supports_tools: true,
        supports_structured_output: false,
        throughput: 40,
      }),
      host('deepinfra', {
        context_length: 4096,
        pricing: { input: 0.5, output: 0.9 },
        supports_tools: true,
        supports_structured_output: false,
        throughput: 40,
      }),
    ]),
    model('route/tie-price', [
      host('novita', {
        context_length: 8192,
        pricing: { input: 0.2, output: 0.4 },
        supports_tools: true,
        supports_structured_output: true,
        throughput: 40,
      }),
      host('together', {
        context_length: 8192,
        pricing: { input: 0.2, output: 0.4 },
        supports_tools: true,
        supports_structured_output: true,
        throughput: 40,
      }),
    ]),
    // `:fastest` is highest throughput, not the lowest output price.
    model('route/fast-not-cheap', [
      host('cerebras', {
        context_length: 65536,
        pricing: { input: 0.9, output: 2 },
        supports_tools: true,
        supports_structured_output: false,
        throughput: 200,
      }),
      host('novita', {
        context_length: 1000000,
        pricing: { input: 0.1, output: 0.2 },
        supports_tools: false,
        supports_structured_output: true,
        throughput: 20,
      }),
    ]),
    // The fastest host publishes no context. The slower one does not fill it.
    model('route/fast-no-context', [
      host('cerebras', {
        pricing: { input: 0.1, output: 0.1 },
        supports_tools: false,
        supports_structured_output: false,
        throughput: 1000,
      }),
      host('novita', {
        context_length: 16384,
        pricing: { input: 0.02, output: 0.05 },
        supports_tools: false,
        supports_structured_output: false,
        throughput: 80,
      }),
    ]),
    // An error host is not the route, even with a higher throughput.
    model('route/error-faster', [
      host('fireworks-ai', {
        status: 'error',
        context_length: 1000,
        pricing: { input: 9, output: 9 },
        supports_tools: false,
        supports_structured_output: false,
        throughput: 500,
      }),
      host('novita', {
        context_length: 8192,
        pricing: { input: 0.1, output: 0.2 },
        supports_tools: true,
        supports_structured_output: false,
        throughput: 10,
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
  it('stores a fact only when every provider states it and agrees', async () => {
    const { models, docsFailures } = await parseHuggingFaceModels(FIXTURE)
    expect(docsFailures).toEqual({ failed: 0, skipped: 0, first: [] })
    const byId = Object.fromEntries(models.map((m) => [m.rawId, m]))

    expect(byId['agree/all']).toMatchObject({
      activity: 'chat',
      contextWindow: 40960,
      capabilities: ['tools'],
      pricing: {
        tables: {
          rate: {
            base: { input_tokens: 0.07 / 1e6, output_tokens: 0.2 / 1e6 },
          },
        },
        source: { url: HUGGINGFACE_MODELS_URL },
      },
      factSources: {
        contextWindow: {
          ...listing,
          path: 'providers[provider=nscale].context_length',
        },
        pricing: { ...listing, path: 'providers[provider=nscale].pricing' },
        capabilities: {
          tools: {
            ...listing,
            path: 'providers[provider=nscale].supports_tools',
          },
        },
      },
    })

    // `agree/all`: every host says no structured output. That is a stated
    // no, and it says nothing about plain `response_format`.
    expect(byId['agree/all']?.unsupportedCapabilities).toEqual([
      'structured_outputs',
    ])
    expect(byId['agree/all']?.factSources?.capabilities).toMatchObject({
      structured_outputs: {
        ...listing,
        path: 'providers[provider=nscale].supports_structured_output',
      },
    })
    expect(byId['promo/free']?.unsupportedCapabilities).toEqual([
      'tools',
      'structured_outputs',
    ])

    expect(byId['agree/but-one-silent']).toMatchObject({
      contextWindow: 40960,
      capabilities: [],
      unsupportedCapabilities: ['tools', 'structured_outputs'],
      pricing: {
        tables: {
          rate: {
            base: { input_tokens: 0.07 / 1e6, output_tokens: 0.2 / 1e6 },
          },
        },
      },
      factSources: {
        contextWindow: {
          ...listing,
          path: 'providers[provider=nscale].context_length',
        },
        pricing: { ...listing, path: 'providers[provider=nscale].pricing' },
        capabilities: {
          tools: {
            ...listing,
            path: 'providers[provider=nscale].supports_tools',
          },
          structured_outputs: {
            ...listing,
            path: 'providers[provider=nscale].supports_structured_output',
          },
        },
      },
    })
    expect(byId['agree/float-noise']?.pricing).toMatchObject({
      tables: {
        rate: {
          base: { input_tokens: 0.06 / 1e6, output_tokens: 2.501 / 1e6 },
        },
      },
    })
    expect(byId['single/float-noise']?.pricing).toMatchObject({
      tables: {
        rate: {
          base: { input_tokens: 0.03 / 1e6, output_tokens: 0.12 / 1e6 },
        },
      },
    })

    expect(byId['split/price']).toMatchObject({
      contextWindow: 1048576,
      pricing: null,
      capabilities: ['tools', 'structured_outputs', 'response_format'],
    })
    expect(byId['split/price']?.factSources).toEqual({
      contextWindow: {
        ...listing,
        path: 'providers[provider=fireworks-ai].context_length',
      },
      capabilities: {
        tools: {
          ...listing,
          path: 'providers[provider=fireworks-ai].supports_tools',
        },
        structured_outputs: {
          ...listing,
          path: 'providers[provider=fireworks-ai].supports_structured_output',
        },
        response_format: {
          ...listing,
          path: 'providers[provider=fireworks-ai].supports_structured_output',
        },
      },
    })

    expect(byId['split/context']).toMatchObject({
      contextWindow: 65536,
      capabilities: ['tools', 'structured_outputs', 'response_format'],
      factSources: {
        contextWindow: {
          ...listing,
          path: 'providers[provider=cerebras].context_length',
        },
        pricing: { ...listing, path: 'providers[provider=cerebras].pricing' },
      },
    })
    expect(byId['split/context']?.pricing).not.toBeNull()

    expect(byId['route/tie']).toMatchObject({
      contextWindow: 4096,
      pricing: null,
      capabilities: ['tools'],
      factSources: {
        contextWindow: {
          ...listing,
          path: 'providers[provider=deepinfra,novita].context_length',
        },
        capabilities: {
          tools: {
            ...listing,
            path: 'providers[provider=deepinfra,novita].supports_tools',
          },
        },
      },
    })
    expect(byId['route/tie-price']).toMatchObject({
      contextWindow: 8192,
      factSources: {
        pricing: {
          ...listing,
          path: 'providers[provider=novita,together].pricing',
        },
      },
    })
    expect(byId['route/tie-price']?.pricing).toMatchObject({
      tables: {
        rate: {
          base: { input_tokens: 0.2 / 1e6, output_tokens: 0.4 / 1e6 },
        },
      },
    })
    expect(byId['route/fast-not-cheap']).toMatchObject({
      contextWindow: 65536,
      capabilities: ['tools'],
      factSources: {
        pricing: { ...listing, path: 'providers[provider=cerebras].pricing' },
      },
    })
    expect(byId['route/fast-not-cheap']?.pricing).toMatchObject({
      tables: {
        rate: { base: { input_tokens: 0.9 / 1e6, output_tokens: 2 / 1e6 } },
      },
    })
    expect(byId['route/fast-no-context']).toMatchObject({
      contextWindow: null,
      capabilities: [],
      factSources: {
        pricing: { ...listing, path: 'providers[provider=cerebras].pricing' },
      },
    })
    expect(byId['route/error-faster']).toMatchObject({
      contextWindow: 8192,
      capabilities: ['tools'],
      factSources: {
        contextWindow: {
          ...listing,
          path: 'providers[provider=novita].context_length',
        },
        pricing: { ...listing, path: 'providers[provider=novita].pricing' },
      },
    })

    expect(byId['unranked/only']).toMatchObject({
      contextWindow: null,
      pricing: null,
      capabilities: null,
      factSources: {},
    })
    // A promo is not the standard price; settled "no" flags are an empty list.
    expect(byId['promo/free']).toMatchObject({
      contextWindow: 8192,
      pricing: null,
      capabilities: [],
    })
    expect(byId['image/model']).toMatchObject({
      activity: 'image',
      pricing: null,
    })

    // No price is said, not left out: the poller then drops a stored card
    // instead of keeping it as a parser miss.
    for (const row of models) {
      expect(row.absent).toEqual(
        row.pricing === null ? { pricing: 'cleared' } : undefined,
      )
    }
    // A zero quote and a null `pricing` both state no price.
    const none = await parseHuggingFaceModels({
      data: [
        model('zero/quote', [
          host('novita', { pricing: { input: 0, output: 0 } }),
        ]),
        model('null/quote', [host('novita', { pricing: null })]),
        ...FIXTURE.data,
      ],
    })
    expect(none.docsFailures.failed).toBe(0)
    for (const row of none.models.slice(0, 2)) {
      expect(row).toMatchObject({
        pricing: null,
        absent: { pricing: 'cleared' },
      })
    }
  })

  // `cleared` drops a stored card, so nothing the parser cannot read may
  // come out as "no price".
  it('throws on a listing-wide reshape instead of clearing', async () => {
    const replay = (edit: (json: string) => string) =>
      parseHuggingFaceModels(JSON.parse(edit(JSON.stringify(FIXTURE))))
    // The listing with its price keys renamed, then with numbers as strings.
    await expect(
      replay((json) =>
        json
          .replaceAll('"input":', '"prompt":')
          .replaceAll('"output":', '"completion":'),
      ),
    ).rejects.toThrow(
      /^huggingface: (\d+) of \1 provider prices are in an unread shape$/,
    )
    await expect(
      replay((json) => json.replace(/"(input|output)":([\d.]+)/g, '"$1":"$2"')),
    ).rejects.toThrow(
      /^huggingface: (\d+) of \1 provider prices are in an unread shape$/,
    )
    // Prices moved out of the entries altogether.
    await expect(
      replay((json) => json.replaceAll('"pricing":', '"rates":')),
    ).rejects.toThrow('no provider entry states a price')

    const ranked = host('nscale', {
      context_length: 40960,
      pricing: { input: 0.07, output: 0.2 },
    })
    for (const providers of [
      { nscale: ranked },
      [ranked, 'featherless-ai'],
      undefined,
    ]) {
      await expect(
        parseHuggingFaceModels({
          data: [...FIXTURE.data, model('x/y', providers)],
        }),
      ).rejects.toThrow('a providers list is in an unread shape')
    }
    // More than a tenth of the stated prices unreadable is a reshape too.
    const odd = (id: string) =>
      model(id, [{ ...ranked, pricing: { input: 0.07 } }])
    await expect(
      parseHuggingFaceModels({
        data: [...FIXTURE.data, odd('a/1'), odd('a/2'), odd('a/3'), odd('a/4')],
      }),
    ).rejects.toThrow(
      /^huggingface: 4 of \d+ provider prices are in an unread shape$/,
    )
  })

  it('withholds only that row’s price when one entry’s price is unreadable', async () => {
    const ranked = host('nscale', {
      context_length: 40960,
      pricing: { input: 0.07, output: 0.2 },
    })
    const clean = await parseHuggingFaceModels(FIXTURE)
    for (const pricing of [
      0.07,
      '0.07',
      { input: 0.07 },
      { input: -1, output: 1 },
    ]) {
      const { models, docsFailures } = await parseHuggingFaceModels({
        data: [
          // A second, readable entry: the row still cannot be settled.
          model('x/y', [ranked, { ...ranked, provider: 'novita', pricing }]),
          ...FIXTURE.data,
        ],
      })
      expect(docsFailures).toEqual({
        failed: 1,
        skipped: 0,
        first: [
          {
            source: `${HUGGINGFACE_MODELS_URL}#x/y`,
            error:
              'huggingface: the price of provider entry "novita" is in an unread shape',
            elapsedMs: expect.any(Number) as number,
          },
        ],
      })
      // Kept as stored, not cleared; its other facts are read as usual.
      expect(models[0]).toMatchObject({
        rawId: 'x/y',
        contextWindow: 40960,
        pricing: null,
        absent: { pricing: 'unavailable' },
      })
      const facts = ({ pricing: card, ...rest }: (typeof models)[number]) => ({
        ...rest,
        priced: card !== null,
      })
      expect(models.slice(1).map(facts)).toEqual(clean.models.map(facts))
    }
  })

  it('leaves context and flags null when their fields change type', async () => {
    const {
      models: [row],
    } = await parseHuggingFaceModels({
      data: [
        model('x/y', [
          host('nscale', {
            context_length: '40960',
            pricing: { input: 0.07, output: 0.2 },
            supports_tools: 'yes',
          }),
        ]),
      ],
    })
    expect(row).toMatchObject({ contextWindow: null, capabilities: null })
  })

  it('throws when a provider status is not live or error', async () => {
    await expect(
      parseHuggingFaceModels({
        data: [
          model('x/y', [
            host('novita', {
              status: 'staging',
              context_length: 8192,
              pricing: { input: 0.1, output: 0.2 },
              throughput: 10,
            }),
          ]),
        ],
      }),
    ).rejects.toThrow('status is in an unread shape')
  })

  it('throws on a payload that lists nothing', async () => {
    await expect(parseHuggingFaceModels({ data: [] })).rejects.toThrow(
      'listed no ids',
    )
    await expect(parseHuggingFaceModels('<html>')).rejects.toThrow(
      'no data array',
    )
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
