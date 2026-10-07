import { afterEach, describe, expect, it } from 'vitest'

import { price } from '@modelschemas/rate-card'
import type { RateCard } from '@modelschemas/rate-card'

import {
  BEDROCK_CARDS_URL,
  bedrockCardPrice,
  bedrockReasoning,
  parseBedrockCard,
} from '../bedrock-cards.ts'
import {
  BEDROCK_METERED_URL,
  BEDROCK_PRICE_LIST_URL,
  BEDROCK_PRICING_PAGE_URL,
} from '../bedrock-pricing.ts'
import { BEDROCK_SDK_MODEL_URL } from '../bedrock-sdk-spec.ts'
import { sha256Text } from '../types.ts'
import { provider } from './amazon-bedrock.ts'

const DOCS = 'https://docs.aws.amazon.com/bedrock/latest/userguide/'
const YES = `![supported](${DOCS}images/icons/icon-yes.png)`
const NO = `![not-supported](${DOCS}images/icons/icon-no.png)`

// AWS ends every table line with `| ` — the trailing space is deliberate.
const INDEX = `# Models at a glance
| Logo | Provider | Supported models |
| --- | --- | --- |
| x | [Anthropic](model-cards-anthropic.md) | [Claude Sonnet 4.5](model-card-anthropic-claude-sonnet-4-5.md) |
| x | [OpenAI](model-cards-openai.md) | [GPT-6 Sol](model-card-openai-gpt-6-sol.md), [GPT-5.4](model-card-openai-gpt-54.md) |
`

/** Older layout: two-column modalities, an API table per endpoint. */
const SONNET = `# Claude Sonnet 4.5

## Model Details
+ **Model launch date:** Sep 30, 2025
+ **Model lifecycle:** Legacy
+ **Context window:** 200K tokens
+ **Max output tokens:** 64K
+ **Reasoning:** Supported

| **Input Modalities** | **Output Modalities** |
| --- | --- |
| ${YES} Image | ${NO} Image |
| ${NO} Speech | ${NO} Speech |
| ${YES} Text | ${YES} Text |

**APIs supported on bedrock-runtime endpoint**

| **Messages** | **Responses** | **Chat Completions** | **Converse** | **Invoke** |
| --- | --- | --- | --- | --- |
| ${NO} | ${NO} | ${NO} | ${YES} | ${YES} |

## Pricing
For pricing, see the [Amazon Bedrock Pricing](https://aws.amazon.com/bedrock/pricing/) page.

## Programmatic Access

| **Endpoint** | **Model ID** | **In-Region endpoint URL** | **Geo inference ID** | **Global inference ID** |
| --- | --- | --- | --- | --- |
| bedrock-runtime | anthropic.claude-sonnet-4-5-20250929-v1:0 | N/A | us.anthropic.claude-sonnet-4-5-20250929-v1:0<br />eu.anthropic.claude-sonnet-4-5-20250929-v1:0 | global.anthropic.claude-sonnet-4-5-20250929-v1:0 |

## Regional Availability
`

const PRICE_HEAD = `| **Inference option** | **Input** | **Input — cache write** | **Input — cache read** | **Output** |
| --- | --- | --- | --- | --- | `

/** Priced, and the global profile bills less than the in-Region id. */
const GPT6 = `# GPT-6 Sol

## Model details
+ **Model launch date:** September 22, 2026
+ **Model lifecycle:** Active
+ **Context window:** 1,050,000 tokens
+ **Max output tokens:** 128,000

| **Input modalities** | **Output modalities** |
| --- | --- |
| ${YES} Text | ${YES} Text |

Set \`prompt_cache_options.ttl\` to \`30m\`, the only supported TTL and the default.

## Pricing

All prices are in USD per 1 million tokens for the Standard tier.

### Commercial Regions — short context (272K input tokens or fewer)

${PRICE_HEAD}
| Mantle in-Region | $2.20 | $2.75 | $0.22 | $11.00 |
| Global CRIS | $2.00 | $2.50 | $0.20 | $10.00 |

### Commercial Regions — long context (more than 272K input tokens)

${PRICE_HEAD}
| Mantle in-Region | $4.40 | $5.50 | $0.44 | $16.50 |
| Global CRIS | $4.00 | $5.00 | $0.40 | $15.00 |

## Call the model

| **Endpoint** | **Model ID** | **In-Region endpoint URL** | **Geo inference ID** | **Global inference ID** |
| --- | --- | --- | --- | --- |
| bedrock-runtime | openai.gpt-6-sol | Not supported | us.openai.gpt-6-sol | global.openai.gpt-6-sol |
| bedrock-mantle | openai.gpt-6-sol | https://bedrock-mantle.{region}.api.aws/openai/v1 | Not supported | Not supported |

## Service tiers
`

/** Prices only a cross-Region profile: the base id gets no card. */
const GPT54 = `# GPT-5.4

## Model details
+ **Model lifecycle:** Active

| **Input Modalities** | **Output Modalities** | **[APIs supported](apis.html)** | **[Endpoints supported](endpoints.html)** |
| --- | --- | --- | --- |
| ${YES} Text | ${YES} Text | ${YES} Converse | ${YES} bedrock-runtime |

## Pricing

| **Inference option** | **Input** | **Output** |
| --- | --- | --- |
| Global CRIS | $2.00 | $6.00 |

*All prices are per 1 million tokens.*

## Programmatic Access

| **Endpoint** | **Model ID** | **In-Region endpoint URL** | **Geo inference ID** | **Global inference ID** |
| --- | --- | --- | --- | --- |
| bedrock-runtime | openai.gpt-5.4 | N/A | Not supported | global.openai.gpt-5.4 |

## Service Tiers
`

const SDK_MODEL = {
  operations: {
    Converse: {
      http: { method: 'POST', requestUri: '/model/{modelId}/converse' },
      input: { shape: 'ConverseRequest' },
      output: { shape: 'ConverseResponse' },
      documentation: '<p>Sends messages to the model.</p>',
    },
  },
  shapes: {
    ConverseRequest: {
      type: 'structure',
      required: ['modelId', 'messages'],
      members: {
        modelId: { shape: 'ModelId', location: 'uri' },
        messages: { shape: 'Messages', documentation: '<p>The messages.</p>' },
      },
    },
    ConverseResponse: {
      type: 'structure',
      members: { stopReason: { shape: 'StopReason' } },
    },
    ModelId: { type: 'string', pattern: '(?<bad' },
    Messages: { type: 'list', member: { shape: 'ContentBlock' }, min: 1 },
    ContentBlock: {
      type: 'structure',
      union: true,
      members: { text: { shape: 'Text' }, json: { shape: 'Document' } },
    },
    Text: { type: 'string', max: 10 },
    Document: { type: 'structure', members: {}, document: true },
    StopReason: { type: 'string', enum: ['end_turn', 'max_tokens'] },
    Throttled: { type: 'structure', members: {}, exception: true },
  },
}

const PRICE_OFFER = {
  products: {
    input: {
      attributes: {
        usagetype: 'USE1-example.model-mantle-input-tokens-standard',
        inferenceType: 'Input tokens',
        service_tier: 'standard',
        feature: '',
        model: 'Example Model',
      },
    },
    output: {
      attributes: {
        usagetype: 'USE1-example.model-mantle-output-tokens-standard',
        inferenceType: 'Output tokens',
        service_tier: 'standard',
        feature: '',
        model: 'Example Model',
      },
    },
  },
  terms: {
    OnDemand: {
      input: {
        t: {
          priceDimensions: {
            d: {
              unit: '1M tokens',
              beginRange: '0',
              endRange: 'Inf',
              pricePerUnit: { USD: '3' },
            },
          },
        },
      },
      output: {
        t: {
          priceDimensions: {
            d: {
              unit: '1M tokens',
              beginRange: '0',
              endRange: 'Inf',
              pricePerUnit: { USD: '9' },
            },
          },
        },
      },
    },
  },
}

const PRICE_PAGE = `<h2>Geo and In-region Cross-region Inference</h2>
<table><thead><tr><th>Models</th><th>Price per 1M input tokens</th><th>Price per 1M output tokens</th></tr></thead>
<tbody><tr><td>Page Only</td><td>$2.00</td><td>$4.00</td></tr></tbody></table>`

const PAGES: Record<string, string> = {
  [BEDROCK_CARDS_URL]: INDEX,
  [`${DOCS}model-card-anthropic-claude-sonnet-4-5.md`]: SONNET,
  [`${DOCS}model-card-openai-gpt-6-sol.md`]: GPT6,
  [`${DOCS}model-card-openai-gpt-54.md`]: GPT54,
  [BEDROCK_SDK_MODEL_URL]: JSON.stringify(SDK_MODEL),
  [BEDROCK_PRICE_LIST_URL]: JSON.stringify(PRICE_OFFER),
  [BEDROCK_PRICING_PAGE_URL]: PRICE_PAGE,
  [BEDROCK_METERED_URL]: JSON.stringify({
    regions: { 'US East (N. Virginia)': {} },
  }),
}

const originalFetch = globalThis.fetch
let urls: Array<string> = []

function serve(pages: Record<string, string>): void {
  urls = []
  globalThis.fetch = ((input: string, init?: RequestInit) => {
    const url = String(input)
    urls.push(url)
    // docs.aws.amazon.com answers 403 without a User-Agent.
    const agent = new Headers(init?.headers).has('User-Agent')
    const body = url.startsWith(DOCS) && !agent ? undefined : pages[url]
    return Promise.resolve(
      body === undefined
        ? new Response('missing', { status: 404 })
        : new Response(body),
    )
  }) as typeof fetch
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('amazon-bedrock', () => {
  it('lists models from the model cards and nothing else', async () => {
    serve(PAGES)
    const { models, skipped } = await provider.listModels({})

    expect(skipped).toBeUndefined()
    expect(urls.filter((url) => !url.startsWith(DOCS)).sort()).toEqual(
      [
        BEDROCK_METERED_URL,
        BEDROCK_PRICE_LIST_URL,
        BEDROCK_PRICING_PAGE_URL,
      ].sort(),
    )
    expect(models.map((model) => model.rawId)).toEqual([
      'anthropic.claude-sonnet-4-5-20250929-v1:0',
      'openai.gpt-6-sol',
      'openai.gpt-5.4',
    ])
    const cardUrl = `${DOCS}model-card-anthropic-claude-sonnet-4-5.md`
    const source = {
      derivation: 'docs-derived' as const,
      sourceUrl: cardUrl,
      sourceHash: await sha256Text(SONNET),
    }
    expect(models[0]).toEqual({
      rawId: 'anthropic.claude-sonnet-4-5-20250929-v1:0',
      displayName: 'Claude Sonnet 4.5',
      activity: 'chat',
      contextWindow: 200_000,
      maxOutput: 64_000,
      modalities: { input: ['image', 'text'], output: ['text'] },
      // The card names no dollar amount, and the fixtures do not price it.
      pricing: null,
      capabilities: ['reasoning'],
      reasoning: null,
      // Converse roles are user, assistant, system. No reasoning_effort.
      requestMap: {
        thinking: null,
        maxTokensField: null,
        developerRole: false,
        replayReasoningContent: null,
        store: null,
        strictTools: null,
        sessionAffinity: null,
        cacheControl: null,
        toolStream: null,
        reasoningEffort: false,
      },
      schemaEndpointId: 'model/{modelId}/converse',
      aliases: [
        'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
        'eu.anthropic.claude-sonnet-4-5-20250929-v1:0',
        'global.anthropic.claude-sonnet-4-5-20250929-v1:0',
      ],
      deprecated: true,
      releasedAt: Date.UTC(2025, 8, 30) / 1000,
      factSources: {
        contextWindow: { ...source, path: 'contextWindow' },
        maxOutput: { ...source, path: 'maxOutput' },
        modalities: { ...source, path: 'modalities' },
        capabilities: {
          reasoning: { ...source, path: 'capabilities.reasoning' },
        },
      },
    })
  })

  it('prices the base id at the in-Region rate with the long-context tier', async () => {
    serve(PAGES)
    const { models } = await provider.listModels({})
    const sol = models[1]
    const card = sol?.pricing as RateCard

    expect(
      price(card, {}, { input_tokens: 1e5, output_tokens: 1e6 }),
    ).toBeCloseTo(0.1 * 2.2 + 11)
    expect(
      price(card, {}, { input_tokens: 3e5, output_tokens: 1e6 }),
    ).toBeCloseTo(0.3 * 4.4 + 16.5)
    // The column says "cache write". The card's only TTL is 30m, so the
    // 5-minute lever stays empty. Cache read stays.
    expect(card.inputs.cache_write_tokens).toBeUndefined()
    expect(card.inputs.cache_write_1h_tokens).toBeUndefined()
    expect(card.inputs.cache_read_tokens).toBeDefined()
    // The global profile bills less, so it must not resolve to this card.
    expect(sol?.aliases).toEqual([])
    expect(sol?.releasedAt).toBe(Date.UTC(2026, 8, 22) / 1000)
    // Only a cross-Region profile is priced: no card for the base id.
    expect(models[2]?.pricing).toBeNull()
    expect(models[2]?.aliases).toEqual(['global.openai.gpt-5.4'])
    expect(models[2]?.schemaEndpointId).toBe('model/{modelId}/converse')
  })

  it('fails the poll when most cards stop stating a model id', async () => {
    const blank = '# Card\n'
    serve({
      ...PAGES,
      [`${DOCS}model-card-openai-gpt-6-sol.md`]: blank,
      [`${DOCS}model-card-openai-gpt-54.md`]: blank,
    })
    await expect(provider.listModels({})).rejects.toThrow(
      '1 of 3 cards state a model id',
    )
  })

  it('reads the reasoning control a card names', () => {
    expect(bedrockReasoning('Supported')).toBeNull()
    expect(
      bedrockReasoning('Supported (configurable: none, low, medium, high)'),
    ).toEqual({
      mode: 'effort',
      mandatory: false,
      efforts: ['none', 'low', 'medium', 'high'],
    })
    expect(
      bedrockReasoning(
        'Supported (adaptive thinking is always on and cannot be disabled; effort level is configurable)',
      ),
    ).toEqual({ mode: 'adaptive', mandatory: true })
    expect(
      bedrockReasoning(
        'Supported (adaptive thinking is always on and cannot be disabled; effort level configurable — low, medium, high, xhigh, max; default: high)',
      ),
    ).toEqual({
      mode: 'adaptive',
      mandatory: true,
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    })
  })

  it('reads a two-space limit bullet and ignores the GovCloud table', () => {
    const card = parseBedrockCard(
      `# GPT
+  **Context window:** 1M tokens
+  **Max output tokens:** 131,072

| **Endpoint** | **Model ID** | **In-Region endpoint URL** | **Geo inference ID** | **Global inference ID** |
| --- | --- | --- | --- | --- |
| bedrock-runtime | openai.gpt-6.1-sol | https://example | Not supported | Not supported |
`,
      { url: 'https://example.test/card', hash: 'h', extractedAt: 't' },
    )
    expect(card?.contextWindow).toBe(1_000_000)
    expect(card?.maxOutput).toBe(131_072)
    expect(card?.requestMap).toBeNull()

    const priced = `
## Pricing
| **Inference option** | **Input** | **Output** | **Cache read** |
| --- | --- | --- | --- |
| In-Region | $1.25 | $2.50 | $0.20 |

**AWS GovCloud (US-West)**

| **Inference option** | **Input** | **Output** | **Cache read** |
| --- | --- | --- | --- |
| In-Region | $1.50 | $3.00 | $0.24 |

*All prices are per 1 million tokens.*
`
    const govPrice = bedrockCardPrice(priced)
    expect(govPrice?.uniform).toBe(true)
    expect(govPrice?.base.input_tokens).toBeCloseTo(1.25 / 1e6)
    expect(govPrice?.base.cache_read_tokens).toBeCloseTo(0.2 / 1e6)
  })

  it('prices GPT-6 Astra standard in-region and drops 30-minute writes and Ultrafast', () => {
    // Published rows from model-card-openai-gpt-6-astra.md.
    const card = bedrockCardPrice(`
## Pricing

All prices are in USD per 1 million tokens. The following tables list Standard and Ultrafast prices.

### Standard — Commercial Regions, short context (272K input tokens or fewer)

| **Inference option** | **Input** | **Input — 30m cache write** | **Input — cache read** | **Output** |
| --- | --- | --- | --- | --- |
| In-Region | $11.00 | $13.75 | $1.10 | $55.00 |
| Geo CRIS | $11.00 | $13.75 | $1.10 | $55.00 |
| Global CRIS | $10.00 | $12.50 | $1.00 | $50.00 |

### Standard — Commercial Regions, long context (more than 272K input tokens)

| **Inference option** | **Input** | **Input — 30m cache write** | **Input — cache read** | **Output** |
| --- | --- | --- | --- | --- |
| In-Region | $22.00 | $27.50 | $2.20 | $82.50 |
| Geo CRIS | $22.00 | $27.50 | $2.20 | $82.50 |
| Global CRIS | $20.00 | $25.00 | $2.00 | $75.00 |

### Ultrafast — Commercial Regions, short context (272K input tokens or fewer)

| **Inference option** | **Input** | **Input — 30m cache write** | **Input — cache read** | **Output** |
| --- | --- | --- | --- | --- |
| In-Region (us-east-1) | $66.00 | $82.50 | $6.60 | $330.00 |
| Global CRIS | $60.00 | $75.00 | $6.00 | $300.00 |

### Ultrafast — Commercial Regions, long context (more than 272K input tokens)

| **Inference option** | **Input** | **Input — 30m cache write** | **Input — cache read** | **Output** |
| --- | --- | --- | --- | --- |
| In-Region (us-east-1) | $132.00 | $165.00 | $13.20 | $495.00 |
| Global CRIS | $120.00 | $150.00 | $12.00 | $450.00 |
`)
    expect(card?.base).toEqual({
      input_tokens: 11 / 1e6,
      output_tokens: 55 / 1e6,
      cache_read_tokens: 1.1 / 1e6,
    })
    expect(card?.tiers).toEqual([
      {
        minPromptTokens: 272_000,
        rates: {
          input_tokens: 22 / 1e6,
          output_tokens: 82.5 / 1e6,
          cache_read_tokens: 2.2 / 1e6,
        },
      },
    ])
  })

  it('leaves a 30-minute cache-write column empty', () => {
    // Published rows from model-card-openai-gpt-56-sol.md. The write is
    // $5.50 on the $4.40 tier and $11.00 on the long tier.
    const card = bedrockCardPrice(`
## Pricing

All prices are in USD per 1 million tokens for the Standard tier.

### Commercial Regions — short context (272K input tokens or fewer)

| **Inference option** | **Input** | **Input — 30m cache write** | **Input — cache read** | **Output** |
| --- | --- | --- | --- | --- |
| In-Region | $4.40 | $5.50 | $0.44 | $22.00 |
| Global CRIS | $4.00 | $5.00 | $0.40 | $20.00 |

### Commercial Regions — long context (more than 272K input tokens)

| **Inference option** | **Input** | **Input — 30m cache write** | **Input — cache read** | **Output** |
| --- | --- | --- | --- | --- |
| In-Region | $8.80 | $11.00 | $0.88 | $33.00 |
| Global CRIS | $8.00 | $10.00 | $0.80 | $30.00 |

### AWS GovCloud (US-East and US-West)

#### Long context (more than 272K input tokens)

| **Inference option** | **Input** | **Input — 30m cache write** | **Input — cache read** | **Output** |
| --- | --- | --- | --- | --- |
| In-Region | $5.40 | $6.75 | $0.54 | $24.30 |
`)
    expect(card?.base).toEqual({
      input_tokens: 4.4 / 1e6,
      output_tokens: 22 / 1e6,
      cache_read_tokens: 0.44 / 1e6,
    })
    expect(card?.tiers).toEqual([
      {
        minPromptTokens: 272_000,
        rates: {
          input_tokens: 8.8 / 1e6,
          output_tokens: 33 / 1e6,
          cache_read_tokens: 0.88 / 1e6,
        },
      },
    ])
  })

  it('maps a 5-minute write, a 1-hour write, and a bare write with no TTL', () => {
    const named = bedrockCardPrice(`
## Pricing

All prices are in USD per 1 million tokens.

| **Inference option** | **Input** | **Input — 5m cache write** | **Input — 1h cache write** | **Input — cache read** | **Output** |
| --- | --- | --- | --- | --- | --- |
| In-Region | $1.00 | $1.25 | $2.00 | $0.10 | $5.00 |
`)
    expect(named?.base).toEqual({
      input_tokens: 1 / 1e6,
      cache_write_tokens: 1.25 / 1e6,
      cache_write_1h_tokens: 2 / 1e6,
      cache_read_tokens: 0.1 / 1e6,
      output_tokens: 5 / 1e6,
    })

    const bare = bedrockCardPrice(`
## Pricing

All prices are in USD per 1 million tokens.

| **Inference option** | **Input** | **Input — cache write** | **Output** |
| --- | --- | --- | --- |
| In-Region | $2.00 | $2.50 | $6.00 |
`)
    expect(bare?.base.cache_write_tokens).toBeCloseTo(2.5 / 1e6)
  })

  it('reads named reasoning levels from the effort section', () => {
    const card = parseBedrockCard(
      `# Model

**Reasoning effort**

Set reasoning effort to \`none\`, \`low\`, \`medium\`, \`high\`, \`xhigh\`, or \`max\`.

| **Endpoint** | **Model ID** | **In-Region endpoint URL** | **Geo inference ID** | **Global inference ID** |
| --- | --- | --- | --- | --- |
| bedrock-runtime | openai.gpt-6-sol | https://example | Not supported | Not supported |
`,
      { url: 'https://example.test/card', hash: 'h', extractedAt: 't' },
    )
    expect(card?.reasoning).toEqual({
      mode: 'effort',
      mandatory: false,
      efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    })
    expect(card?.capabilities).toEqual(['reasoning'])
  })

  it('generates the Converse schema from the SDK service model', async () => {
    serve(PAGES)
    const spec = await provider.fetchSpec({})
    const doc = spec.specs[0]

    expect(urls).toEqual([BEDROCK_SDK_MODEL_URL])
    expect(spec.skipped).toBeUndefined()
    expect(Object.keys(doc?.paths ?? {})).toEqual(['/model/{modelId}/converse'])
    expect(provider.classify('/model/{modelId}/converse', {})).toBe('chat')
    expect(doc?.components?.schemas).toEqual({
      // modelId rides the path; the body schema leaves it out.
      ConverseRequest: {
        type: 'object',
        properties: {
          messages: {
            $ref: '#/components/schemas/Messages',
            description: 'The messages.',
          },
        },
        required: ['messages'],
      },
      ConverseResponse: {
        type: 'object',
        properties: { stopReason: { $ref: '#/components/schemas/StopReason' } },
      },
      ModelId: { type: 'string' },
      Messages: {
        type: 'array',
        items: { $ref: '#/components/schemas/ContentBlock' },
        minItems: 1,
      },
      ContentBlock: {
        type: 'object',
        properties: {
          text: { $ref: '#/components/schemas/Text' },
          json: { $ref: '#/components/schemas/Document' },
        },
        minProperties: 1,
        maxProperties: 1,
      },
      Text: { type: 'string', maxLength: 10 },
      Document: {},
      StopReason: { type: 'string', enum: ['end_turn', 'max_tokens'] },
    })
  })
})
