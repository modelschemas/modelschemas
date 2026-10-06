import { afterEach, describe, expect, it } from 'vitest'

import { AZURE_MODELS_URL, AZURE_REASONING_URL } from '../azure-models.ts'
import { AZURE_PRICES_URL, AZURE_PRICING_PAGE_URL } from '../azure-pricing.ts'
import { AZURE_SPEC_URL, provider } from './azure.ts'

/** Excerpts of the two Learn articles' markdown twins (2026-10-06). */
const MODELS = `::: zone pivot="azure-openai"

## O-Series models

| Model ID | Description | Max request (tokens) | Training data (up to) |
| --- | --- | --- | --- |
\`o3-deep-research\` is only available with Foundry Agent Service. The \`o9\` family is not a model.

| \`o3\` (2025-04-16) | - Chat Completions API.  - Structured outputs. - Text and image processing.  - Functions, tools, and parallel tool calling. | Input: 200,000  Output: 100,000 | May 31, 2024 |

## Image generation models

| Model ID | Max request (characters) |
| --- | --- |
| \`gpt-image-2\` | 4,000 |

::: zone-end
`

const REASONING = `| **Feature** | **o3**,**2025-04-16** |
| --- | --- |
| **Reasoning effort** | ✅ |
| Chat Completions API | ✅ |
`

const PAGE_TWO = 'https://prices.azure.com/api/retail/prices?page=2'
const PRICES: Record<string, unknown> = {
  [AZURE_PRICES_URL]: {
    Items: [
      { skuName: 'o3 0416 Inp glbl', unitOfMeasure: '1K', retailPrice: 0.002 },
    ],
    NextPageLink: PAGE_TWO,
  },
  [PAGE_TWO]: {
    Items: [
      { skuName: 'o3 0416 Outp glbl', unitOfMeasure: '1K', retailPrice: 0.008 },
      {
        skuName: 'o3-deep research 0626-inp-glbl',
        unitOfMeasure: '1M',
        retailPrice: 10,
      },
    ],
    NextPageLink: null,
  },
}
const PRICING_PAGE =
  '<td>GPT-5.4 (&lt;272k context length)</td><td>GPT-5.4 (&gt;272k context length)</td>'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function stubFetch(
  models: string,
  urls: Array<string> = [],
  pricingPage = PRICING_PAGE,
) {
  globalThis.fetch = ((input: string, init?: RequestInit) => {
    const url = String(input)
    urls.push(url)
    if (url === AZURE_MODELS_URL || url === AZURE_REASONING_URL) {
      expect(new Headers(init?.headers).get('Accept')).toBe('text/markdown')
      return Promise.resolve(
        new Response(url === AZURE_MODELS_URL ? models : REASONING),
      )
    }
    if (url in PRICES) return Promise.resolve(Response.json(PRICES[url]))
    if (url === AZURE_PRICING_PAGE_URL) {
      return Promise.resolve(new Response(pricingPage))
    }
    if (url === AZURE_SPEC_URL) {
      return Promise.resolve(
        Response.json({ openapi: '3.2.0', paths: { '/chat/completions': {} } }),
      )
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`))
  }) as typeof fetch
}

describe('azure', () => {
  it('lists the tabulated models with facts, price, and sources', async () => {
    stubFetch(MODELS)
    const { models } = await provider.listModels({})

    expect(models.map((model) => [model.rawId, model.activity])).toEqual([
      ['o3', 'chat'],
      ['gpt-image-2', 'image'],
      // Named in prose and metered: kept, with no facts. `o9` is dropped.
      ['o3-deep-research', null],
    ])
    const o3 = models[0]
    expect(o3).toMatchObject({
      contextWindow: 200_000,
      maxOutput: 100_000,
      modalities: { input: ['text', 'image'], output: [] },
      capabilities: [
        'reasoning',
        'tools',
        'structured_outputs',
        'response_format',
      ],
      schemaEndpointId: 'chat/completions',
      pricing: {
        tables: { rate: { base: { input_tokens: 2e-6, output_tokens: 8e-6 } } },
      },
    })
    expect(o3?.factSources?.pricing?.sourceUrl).toBe(AZURE_PRICES_URL)
    expect(o3?.factSources?.maxOutput?.sourceUrl).toBe(AZURE_MODELS_URL)
    expect(models[1]?.pricing).toBeNull()
  })

  it('throws when the pricing page labels no threshold', async () => {
    stubFetch(MODELS, [], '<td>GPT-5.4 Global</td>')
    await expect(provider.listModels({})).rejects.toThrow(
      'labels no context-length threshold',
    )
  })

  it('throws when the models article tabulates nothing', async () => {
    stubFetch('::: zone pivot="azure-openai"\n\nNo tables.\n')
    await expect(provider.listModels({})).rejects.toThrow('parsed 0 model rows')
  })

  it("fetches Azure's own v1 spec and classifies its chat routes", async () => {
    const urls: Array<string> = []
    stubFetch(MODELS, urls)
    const spec = await provider.fetchSpec({})

    expect(urls).toEqual([AZURE_SPEC_URL])
    expect(spec.sources[0]?.url).toBe(AZURE_SPEC_URL)
    expect(spec.specRevision).toBe(spec.sources[0]?.hash)
    expect(provider.classify('/responses', {})).toBe('chat')
    expect(provider.classify('/fine_tuning/jobs', {})).toBeNull()
  })
})
