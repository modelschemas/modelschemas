import { afterEach, describe, expect, it } from 'vitest'

import {
  parsePerplexityModelsPage,
  parsePerplexityPresets,
  provider,
} from './perplexity.ts'

const MODELS_URL = 'https://api.perplexity.ai/v1/models'
const DOC_URL = 'https://docs.perplexity.ai/docs/agent-api/models.md'
const PRESETS_URL = 'https://docs.perplexity.ai/docs/agent-api/presets.md'

const HEADER = [
  '    | Model | Input (\\$/1M) | Output (\\$/1M) | Cache read (\\$/1M) | Service tiers | Docs |',
  '    | - | - | - | - | - | - |',
]

// Five tabs of the Agent API models page, as served on 2026-10-07.
const MODELS_DOC = [
  '## Available Models',
  '',
  '<Tabs>',
  '  <Tab title="xAI">',
  '    <Card title="xAI">',
  '      Grok 4.7, 4.6, 4.5, 4.3, and 4.20 variants: flagship, reasoning, non-reasoning, and multi-agent.',
  '    </Card>',
  '',
  ...HEADER,
  '    | `xai/grok-4.20-non-reasoning` | 1.25 (\\<200k)<br />2.50 (≥200k) | 2.50 (\\<200k)<br />5.00 (≥200k) | 0.20 | — | [Grok 4.20 Non Reasoning](https://docs.x.ai/developers/models) |',
  '  </Tab>',
  '',
  '  <Tab title="Z.AI">',
  '    <Card title="Z.AI">',
  '      GLM 5.3 and GLM 5.3 Flash — Z.AI reasoning models.',
  '    </Card>',
  '',
  ...HEADER,
  '    | `perplexity/glm-5.3` | 1.40 | 4.40 | 0.26 | — | [GLM](https://docs.z.ai) |',
  '    | `perplexity/glm-5.3-flash` | 0.15 | 0.50 | 0.03 | — | [GLM-5.3 Flash](https://huggingface.co/zai-org/GLM-5.3-Flash) |',
  '  </Tab>',
  '',
  '  <Tab title="Moonshot AI">',
  '    <Card title="Moonshot AI">',
  "      Kimi K3 — Moonshot AI's flagship reasoning model.",
  '    </Card>',
  '',
  ...HEADER,
  '    | `perplexity/kimi-k3` | 3.00 | 15.00 | 0.30 | — | [Kimi K3](https://huggingface.co/moonshotai/Kimi-K3) |',
  '',
  '    <Info>',
  '      Kimi K3 accepts `minimal`, `low`, `medium`, `high`, `xhigh`, and `max` reasoning effort. `minimal` uses low effort, while `xhigh` and `max` use maximum effort. Reasoning tokens are billed at the output-token rate.',
  '    </Info>',
  '  </Tab>',
  '',
  '  <Tab title="NVIDIA">',
  '    <Card title="NVIDIA">',
  '      Nemotron 3 Ultra is an open-weight reasoning model.',
  '    </Card>',
  '',
  ...HEADER,
  '    | `perplexity/nemotron-3-ultra-550b-a55b` | 0.25 | 2.50 | 0.25 | — | [Nemotron 3 Ultra](https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-BF16) |',
  '  </Tab>',
  '',
  '  <Tab title="Perplexity">',
  '    <Card title="Perplexity">',
  "      Perplexity's grounded search model.",
  '    </Card>',
  '',
  ...HEADER,
  '    | `perplexity/sonar` | 0.25 | 2.50 | 0.0625 | — | — |',
  '  </Tab>',
  '</Tabs>',
  '',
  '<Warning>',
  '  Not all third-party models support all features (e.g., reasoning, tools). Check model documentation for specific capabilities.',
  '</Warning>',
].join('\n')

const KIMI_SENTENCE =
  'Kimi K3 accepts `minimal`, `low`, `medium`, `high`, `xhigh`, and `max` reasoning effort.'

describe('parsePerplexityModelsPage', () => {
  it('reads the effort sentence and the reasoning-model cards', () => {
    expect([...parsePerplexityModelsPage(MODELS_DOC)]).toEqual([
      ['perplexity/glm-5.3', ['reasoning']],
      ['perplexity/glm-5.3-flash', ['reasoning']],
      ['perplexity/kimi-k3', ['reasoning', 'reasoning_effort']],
      ['perplexity/nemotron-3-ultra-550b-a55b', ['reasoning']],
    ])
  })

  it('leaves the effort flag off when no tab states an effort', () => {
    const silent = MODELS_DOC.replace(/ {4}<Info>[^]*?<\/Info>\n/, '')
    expect(parsePerplexityModelsPage(silent).get('perplexity/kimi-k3')).toEqual(
      ['reasoning'],
    )
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
    [
      'a second sentence for the same model',
      '    </Info>',
      '      Kimi K3 accepts `low` and `high` reasoning effort.\n    </Info>',
    ],
    [
      'the sentence moved outside the tabs',
      /^ {6}Kimi K3 accepts[^]*?(<Warning>)/m,
      `    </Info>\n  </Tab>\n</Tabs>\n\n${KIMI_SENTENCE}\n\n$1`,
    ],
    [
      'a card naming fewer models than its tab lists',
      'GLM 5.3 and GLM 5.3 Flash — Z.AI',
      'GLM 5.3 — Z.AI',
    ],
    [
      'a card that denies it',
      'is an open-weight reasoning model',
      'is not a reasoning model',
    ],
    [
      'a reworded card',
      'is an open-weight reasoning model.',
      'ranks among open reasoning models, in our tests.',
    ],
  ])('throws on %s', (_case, from, to) => {
    const mutated = MODELS_DOC.replace(from, to)
    expect(mutated).not.toBe(MODELS_DOC)
    expect(() => parsePerplexityModelsPage(mutated)).toThrow('unread shape')
  })

  it('throws on a page with no model table, such as an HTML error page', () => {
    expect(() => parsePerplexityModelsPage('<html>Not found</html>')).toThrow(
      'lists no models',
    )
  })
})

// Three of the five presets, bullets as served on 2026-10-07. The prompt
// blocks are cut to one line each; the real ones hold `## ` headings.
const PRESETS_DOC = [
  '## Current preset values',
  '',
  '<AccordionGroup>',
  '  <Accordion title="fast — current preset values">',
  '    Quick factual lookups with minimal latency and inline citations for search-backed claims.',
  '',
  '    * **Model:** `openai/gpt-6-luna`',
  '    * **Prompt cache key:** `fast`',
  '    * **Max steps:** 1',
  '    * **Reasoning effort:** `none`',
  '    * **Service tier:** `priority`',
  '    * **Max output tokens:** 8192',
  '    * **Tools:** `web_search`',
  '    * **System prompt:** included inline below',
  '',
  '    ```text',
  '    ## Role',
  '    ```',
  '  </Accordion>',
  '',
  '  <Accordion title="low — current preset values">',
  '    * **Model:** `openai/gpt-6-luna`',
  '    * **Reasoning effort:** `minimal`',
  '    * **Tools:** `web_search`, `fetch_url` (`max_urls: 1`)',
  '  </Accordion>',
  '',
  '  <Accordion title="xhigh — current preset values">',
  '    * **Model:** `anthropic/claude-opus-5-5`',
  '    * **Max steps:** 100',
  '    * **Reasoning effort:** `high`',
  '    * **Tools:** `web_search`, `finance_search`, `sandbox`',
  '  </Accordion>',
  '</AccordionGroup>',
  '',
  '## Next Steps',
].join('\n')

describe('parsePerplexityPresets', () => {
  it('reads each preset model with the effort and tools it runs with', () => {
    expect([...parsePerplexityPresets(PRESETS_DOC)]).toEqual([
      ['openai/gpt-6-luna', ['reasoning', 'reasoning_effort', 'tools']],
      ['anthropic/claude-opus-5-5', ['reasoning', 'reasoning_effort', 'tools']],
    ])
  })

  it('gives a preset with no tools or effort bullet neither flag', () => {
    const bare = PRESETS_DOC.replace(
      '    * **Reasoning effort:** `high`\n    * **Tools:** `web_search`, `finance_search`, `sandbox`\n',
      '',
    )
    expect(parsePerplexityPresets(bare).has('anthropic/claude-opus-5-5')).toBe(
      false,
    )
  })

  it.each([
    [
      'a preset with no model bullet',
      '* **Model:** `openai',
      '* **LLM:** `openai',
    ],
    ['a model that is prose', '`anthropic/claude-opus-5-5`', 'Claude Opus 5.5'],
    ['an effort that is prose', '`high`', 'high, or lower on retries'],
    [
      'tools that are prose',
      '`web_search`, `finance_search`, `sandbox`',
      'none',
    ],
    [
      'a bullet stated twice',
      '    * **Max steps:** 100',
      '    * **Model:** `openai/gpt-6-sol`',
    ],
    ['a page with no preset accordions', / — current preset values/g, ''],
  ])('throws on %s', (_case, from, to) => {
    const mutated = PRESETS_DOC.replace(from, to)
    expect(mutated).not.toBe(PRESETS_DOC)
    expect(() => parsePerplexityPresets(mutated)).toThrow('perplexity: preset')
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

  it('joins the listing to the flags both docs pages state', async () => {
    const urls: Array<string> = []
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      urls.push(String(url))
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      if (String(url) === DOC_URL) {
        return Promise.resolve(new Response(MODELS_DOC))
      }
      if (String(url) === PRESETS_URL) {
        return Promise.resolve(new Response(PRESETS_DOC))
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
            { id: 'openai/gpt-6-luna', created: 3 },
            { id: 'xai/grok-4.20-non-reasoning', created: 4 },
          ],
        }),
      )
    }) as typeof fetch

    const result = await provider.listModels({
      PERPLEXITY_API_KEY: 'test-key',
    })
    expect(urls.sort()).toEqual([MODELS_URL, DOC_URL, PRESETS_URL])
    expect(result.skipped).toBeUndefined()
    const source = (sourceUrl: string, path: string) => ({
      derivation: 'docs-derived',
      sourceUrl,
      sourceHash: expect.stringMatching(/^[0-9a-f]{64}$/) as string,
      path,
    })
    expect(result.models).toEqual([
      {
        rawId: 'perplexity/kimi-k3',
        releasedAt: 1,
        activity: 'chat',
        capabilities: ['reasoning', 'reasoning_effort'],
        factSources: {
          capabilities: {
            reasoning: source(DOC_URL, 'reasoning'),
            reasoning_effort: source(DOC_URL, 'reasoning_effort'),
          },
        },
      },
      { rawId: 'perplexity/sonar', releasedAt: 2, activity: 'chat' },
      {
        rawId: 'openai/gpt-6-luna',
        releasedAt: 3,
        activity: 'chat',
        capabilities: ['reasoning', 'reasoning_effort', 'tools'],
        factSources: {
          capabilities: {
            reasoning: source(PRESETS_URL, 'reasoning'),
            reasoning_effort: source(PRESETS_URL, 'reasoning_effort'),
            tools: source(PRESETS_URL, 'tools'),
          },
        },
      },
      { rawId: 'xai/grok-4.20-non-reasoning', releasedAt: 4, activity: 'chat' },
    ])
    expect(result.models.every((model) => model.reasoning == null)).toBe(true)
    expect(
      provider.generationEndpointId?.({
        rawId: 'perplexity/sonar',
        activity: 'chat',
      }),
    ).toBe('v1/agent')
  })

  it('fails the poll when a docs page is an HTML error page', async () => {
    globalThis.fetch = ((url: string) =>
      Promise.resolve(
        String(url) === MODELS_URL
          ? Response.json({ data: [{ id: 'perplexity/sonar' }] })
          : new Response('<html>Not found</html>'),
      )) as typeof fetch
    await expect(
      provider.listModels({ PERPLEXITY_API_KEY: 'test-key' }),
    ).rejects.toThrow(/lists no/)
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
