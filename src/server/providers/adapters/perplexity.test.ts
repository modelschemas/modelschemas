import { afterEach, describe, expect, it } from 'vitest'

import { parsePerplexityEfforts, provider } from './perplexity.ts'

const DOC_URL = 'https://docs.perplexity.ai/docs/agent-api/models.md'

// Three tabs of the Agent API models page, as served on 2026-10-07.
const MODELS_DOC = [
  '## Available Models',
  '',
  '<Tabs>',
  '  <Tab title="Z.AI">',
  '    <Card title="Z.AI">',
  '      GLM 5.3 and GLM 5.3 Flash — Z.AI reasoning models.',
  '    </Card>',
  '',
  '    | Model | Input (\\$/1M) | Output (\\$/1M) | Cache read (\\$/1M) | Service tiers | Docs |',
  '    | - | - | - | - | - | - |',
  '    | `perplexity/glm-5.3` | 1.40 | 4.40 | 0.26 | — | [GLM](https://docs.z.ai) |',
  '    | `perplexity/glm-5.3-flash` | 0.15 | 0.50 | 0.03 | — | [GLM-5.3 Flash](https://huggingface.co/zai-org/GLM-5.3-Flash) |',
  '  </Tab>',
  '',
  '  <Tab title="Moonshot AI">',
  '    <Card title="Moonshot AI">',
  "      Kimi K3 — Moonshot AI's flagship reasoning model.",
  '    </Card>',
  '',
  '    | Model | Input (\\$/1M) | Output (\\$/1M) | Cache read (\\$/1M) | Service tiers | Docs |',
  '    | - | - | - | - | - | - |',
  '    | `perplexity/kimi-k3` | 3.00 | 15.00 | 0.30 | — | [Kimi K3](https://huggingface.co/moonshotai/Kimi-K3) |',
  '',
  '    <Info>',
  '      Kimi K3 accepts `minimal`, `low`, `medium`, `high`, `xhigh`, and `max` reasoning effort. `minimal` uses low effort, while `xhigh` and `max` use maximum effort. Reasoning tokens are billed at the output-token rate.',
  '    </Info>',
  '  </Tab>',
  '',
  '  <Tab title="Perplexity">',
  '    | Model | Input (\\$/1M) | Output (\\$/1M) | Cache read (\\$/1M) | Service tiers | Docs |',
  '    | - | - | - | - | - | - |',
  '    | `perplexity/sonar` | 0.25 | 2.50 | 0.0625 | — | — |',
  '  </Tab>',
  '</Tabs>',
  '',
  '<Warning>',
  '  Not all third-party models support all features (e.g., reasoning, tools). Check model documentation for specific capabilities.',
  '</Warning>',
].join('\n')

const KIMI_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

describe('parsePerplexityEfforts', () => {
  it('reads the efforts the page states, for the model the sentence names', () => {
    expect([...parsePerplexityEfforts(MODELS_DOC)]).toEqual([
      ['perplexity/kimi-k3', KIMI_EFFORTS],
    ])
  })

  it('reads none when no tab states an effort', () => {
    const silent = MODELS_DOC.replace(/ {4}<Info>[^]*?<\/Info>\n/, '')
    expect(parsePerplexityEfforts(silent).size).toBe(0)
  })

  it.each([
    ['a reworded sentence', 'Kimi K3 accepts', 'Kimi K3 supports'],
    [
      'a list with prose in it',
      '`xhigh`, and `max`',
      '`xhigh`, and up to `max`',
    ],
    ['a name no row carries', 'Kimi K3 accepts', 'Kimi K4 accepts'],
    [
      'a second, unread mention',
      '</Info>',
      'GLM takes any reasoning effort.\n</Info>',
    ],
  ])('throws on %s', (_case, from, to) => {
    expect(() => parsePerplexityEfforts(MODELS_DOC.replace(from, to))).toThrow(
      'unread shape',
    )
  })

  it('throws on a page with no model table, such as an HTML error page', () => {
    expect(() => parsePerplexityEfforts('<html>Not found</html>')).toThrow(
      'lists no models',
    )
  })
})

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('perplexity provider', () => {
  it('exports seed metadata for the isolation loader', () => {
    expect(provider.id).toBe('perplexity')
    expect(provider.displayName).toBe('Perplexity')
    expect(provider.authEnvVar).toBe('PERPLEXITY_API_KEY')
    expect(provider.defaultDerivation).toBe('upstream-spec')
    expect(provider.specSourceUrl).toBe(
      'https://docs.perplexity.ai/openapi.json',
    )
    expect(provider.modelsEndpoint).toBe('https://api.perplexity.ai/v1/models')
  })
})

describe('perplexity classify', () => {
  it('maps generation paths and drops search, async, and platform', () => {
    expect(provider.classify('/v1/sonar', {})).toBe('chat')
    expect(provider.classify('/v1/agent', {})).toBe('chat')
    expect(provider.classify('/v1/embeddings', {})).toBe('embeddings')
    expect(provider.classify('/v1/contextualizedembeddings', {})).toBe(
      'embeddings',
    )
    expect(provider.classify('/search', {})).toBeNull()
    expect(provider.classify('/v1/async/sonar', {})).toBeNull()
    expect(provider.classify('/v1/models', {})).toBeNull()
    expect(provider.classify('/v1/agent/{id}/cancel', {})).toBeNull()
    expect(provider.classify('/v1/analytics/computer/usage', {})).toBeNull()
  })
})

describe('perplexity listModels', () => {
  it('skips when the secret is absent', async () => {
    const result = await provider.listModels({})
    expect(result.skipped).toBe(
      'perplexity: PERPLEXITY_API_KEY not set — skipped',
    )
    expect(result.models).toEqual([])
  })

  it('parses the OpenAI-style model list when a key is set', async () => {
    const urls: Array<string> = []
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      urls.push(String(url))
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      if (String(url) === DOC_URL) {
        return Promise.resolve(new Response(MODELS_DOC))
      }
      expect(
        new Headers(init?.headers).get('Authorization')?.startsWith('Bearer '),
      ).toBe(true)
      return Promise.resolve(
        Response.json({
          object: 'list',
          data: [
            { id: 'perplexity/kimi-k3', created: 1 },
            { id: 'perplexity/sonar', created: 2 },
          ],
        }),
      )
    }) as typeof fetch

    const result = await provider.listModels({
      PERPLEXITY_API_KEY: 'test-key',
    })
    expect(urls.sort()).toEqual([
      'https://api.perplexity.ai/v1/models',
      DOC_URL,
    ])
    expect(result.skipped).toBeUndefined()
    const source = {
      derivation: 'docs-derived',
      sourceUrl: DOC_URL,
      sourceHash: expect.stringMatching(/^[0-9a-f]{64}$/) as string,
      path: 'reasoning.effort',
    }
    expect(result.models).toEqual([
      {
        rawId: 'perplexity/kimi-k3',
        releasedAt: 1,
        activity: 'chat',
        capabilities: ['reasoning', 'reasoning_effort'],
        reasoning: { mode: 'effort', mandatory: true, efforts: KIMI_EFFORTS },
        factSources: {
          reasoning: source,
          capabilities: { reasoning: source, reasoning_effort: source },
        },
      },
      { rawId: 'perplexity/sonar', releasedAt: 2, activity: 'chat' },
    ])
    expect(
      provider.generationEndpointId?.({
        rawId: 'perplexity/sonar',
        activity: 'chat',
      }),
    ).toBe('v1/agent')
  })

  it('fails the poll when the models page has no model table', async () => {
    globalThis.fetch = ((url: string) =>
      Promise.resolve(
        String(url) === DOC_URL
          ? new Response('<html>Not found</html>')
          : Response.json({ data: [{ id: 'perplexity/sonar' }] }),
      )) as typeof fetch
    await expect(
      provider.listModels({ PERPLEXITY_API_KEY: 'test-key' }),
    ).rejects.toThrow('lists no models')
  })
})

describe('perplexity fetchSpec', () => {
  it('loads the published OpenAPI document without a key', async () => {
    const spec = {
      openapi: '3.1.0',
      info: { title: 'Perplexity AI API' },
      paths: { '/v1/sonar': { post: { summary: 'Create Chat Completion' } } },
    }
    globalThis.fetch = ((url: string) => {
      expect(String(url)).toBe('https://docs.perplexity.ai/openapi.json')
      return Promise.resolve(new Response(JSON.stringify(spec)))
    }) as typeof fetch

    const fetched = await provider.fetchSpec({})
    expect(fetched.specs).toHaveLength(1)
    expect(fetched.specs[0]?.info?.title).toBe('Perplexity AI API')
    expect(fetched.sources[0]?.url).toBe(
      'https://docs.perplexity.ai/openapi.json',
    )
    expect(fetched.sources[0]?.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(fetched.outputStrategy).toBe('post-200')
  })
})
