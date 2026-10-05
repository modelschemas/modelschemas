import { afterEach, describe, expect, it } from 'vitest'

import {
  BASETEN_CHAT_OPENAPI_URL,
  BASETEN_MESSAGES_OPENAPI_URL,
  BASETEN_OVERVIEW_URL,
  BASETEN_PRICING_URL,
  BASETEN_REASONING_URL,
  BASETEN_VISION_URL,
  parseBasetenCatalog,
  provider,
} from './baseten.ts'
import type { BasetenPages } from './baseten.ts'

const OVERVIEW = `
export const SupportedModelsTable = () => {
  const rows = [{
    model: "GLM 5.3",
    slug: "zai-org/GLM-5.3",
    context: 1048,
    maxOutput: 262
  }, {
    model: "DeepSeek V4 Pro 0813",
    slug: "deepseek-ai/DeepSeek-V4-Pro-0813",
    context: 1048,
    maxOutput: 262
  }, {
    model: "OpenAI GPT 120B",
    slug: "openai/gpt-oss-120b",
    context: 128,
    maxOutput: 128
  }, {
    model: "Kimi K3",
    slug: "moonshotai/Kimi-K3",
    context: 262,
    maxOutput: 262
  }, {
    model: "Nemotron Ultra",
    slug: "nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B",
    context: 202,
    maxOutput: 202
  }];
  return <div>{row.context}k {row.maxOutput}k</div>
}
export const FeatureSupportTable = () => {
  const rows = [{
    model: "GLM 5.3",
    reasoning: "Enabled by default",
    vision: "✓"
  }, {
    model: "DeepSeek V4 Pro 0813",
    reasoning: "Enabled by default",
    vision: "–"
  }, {
    model: "OpenAI GPT 120B",
    reasoning: "Enabled by default",
    vision: "–"
  }, {
    model: "Kimi K3",
    reasoning: "Enabled by default",
    vision: "✓"
  }, {
    model: "Nemotron Ultra",
    reasoning: "Opt-in",
    vision: "–"
  }];
}
`

const REASONING = `
## Control reasoning depth

| Model | Supported values |
| - | - |
| GLM 5.3 | \`none\`, \`low\`, \`high\` (default), \`max\` |
| DeepSeek V4 Pro 0813 | \`none\`, \`low\`, \`high\`, \`max\` |
| OpenAI GPT 120B | \`none\`, \`low\`, \`medium\` (default), \`high\` |
| Kimi K3 | \`none\`, \`low\`, \`high\`, \`max\` (default) |

Thinking is always on for the GLM 5.3 family, so \`none\` does not turn it off.

## Set a reasoning token budget
`

const VISION = `
| Limit | GLM 5.3 | Kimi K3 |
| - | -: | -: |
| Max videos per request | Not supported | 12 |
`

const PRICING = `
<p>Price per 1M tokens</p>
${'x'.repeat(5000)}
<p>$99</p>
<p>GLM-5.3</p>
<span>$1.40</span><span>$1.40</span><span>$0.14</span><span>$0.14</span><span>$4.40</span>
<a href="https://app.baseten.co/model-apis/zai-org/GLM-5.3">Try</a>
<p>DeepSeek V4 Pro 0813</p>
<span>$1.32</span><span>$1.32</span><span>$0.132</span><span>$0.132</span><span>$3.96</span>
<a href="https://app.baseten.co/model-apis/deepseek-v4-pro-0813">Try</a>
<p>GPT OSS 120B</p>
<span>$0.10</span><span>$0.10</span><span>$0.50</span><span>$0.50</span>
<a href="https://app.baseten.co/model-apis/openai/gpt-oss-120b">Try</a>
<p>Unlisted</p>
<span>$9.00</span><span>$9.00</span><span>$1.00</span><span>$1.00</span><span>$9.00</span>
<a href="https://app.baseten.co/model-apis/other/nope">Try</a>
`

const HASH = 'a'.repeat(64)

function pages(overrides: Partial<BasetenPages> = {}): BasetenPages {
  return {
    overview: OVERVIEW,
    reasoning: REASONING,
    vision: VISION,
    pricingHtml: PRICING,
    overviewHash: HASH,
    reasoningHash: HASH,
    visionHash: HASH,
    pricingSource: {
      url: BASETEN_PRICING_URL,
      hash: HASH,
      extractedAt: '2026-10-05T00:00:00.000Z',
    },
    ...overrides,
  }
}

const SPEC = {
  openapi: '3.1.0',
  paths: { '/v1/chat/completions': { post: {} } },
}
const MESSAGES = {
  openapi: '3.1.0',
  paths: { '/v1/messages': { post: {} } },
}

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('baseten', () => {
  it('lists docs slugs, per-1M prices, efforts, and vision', () => {
    const models = parseBasetenCatalog(pages())
    const byId = new Map(models.map((model) => [model.rawId, model]))

    expect(models.map((model) => model.rawId)).toEqual([
      'zai-org/GLM-5.3',
      'deepseek-ai/DeepSeek-V4-Pro-0813',
      'openai/gpt-oss-120b',
      'moonshotai/Kimi-K3',
      'nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B',
    ])
    expect(byId.get('zai-org/GLM-5.3')).toMatchObject({
      displayName: 'GLM 5.3',
      activity: 'chat',
      contextWindow: 1_048_000,
      maxOutput: 262_000,
      modalities: { input: ['text', 'image'], output: ['text'] },
      reasoning: {
        mode: 'effort',
        mandatory: true,
        efforts: ['none', 'low', 'high', 'max'],
      },
      pricing: {
        tables: {
          rate: {
            base: {
              input_tokens: 1.4 / 1_000_000,
              cache_read_tokens: 0.14 / 1_000_000,
              output_tokens: 4.4 / 1_000_000,
            },
          },
        },
      },
    })
    expect(byId.get('deepseek-ai/DeepSeek-V4-Pro-0813')).toMatchObject({
      modalities: { input: ['text'], output: ['text'] },
      reasoning: { mandatory: false, efforts: ['none', 'low', 'high', 'max'] },
      pricing: {
        tables: {
          rate: {
            base: {
              input_tokens: 1.32 / 1_000_000,
              cache_read_tokens: 0.132 / 1_000_000,
              output_tokens: 3.96 / 1_000_000,
            },
          },
        },
      },
    })
    expect(byId.get('openai/gpt-oss-120b')?.pricing).toMatchObject({
      tables: {
        rate: {
          base: {
            input_tokens: 0.1 / 1_000_000,
            output_tokens: 0.5 / 1_000_000,
          },
        },
      },
    })
    expect(byId.get('openai/gpt-oss-120b')?.pricing).not.toHaveProperty(
      'tables.rate.base.cache_read_tokens',
    )
    expect(byId.get('moonshotai/Kimi-K3')?.pricing).toBeNull()
    expect(byId.get('moonshotai/Kimi-K3')?.modalities).toEqual({
      input: ['text', 'image', 'video'],
      output: ['text'],
    })
    expect(
      byId.get('nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B')?.reasoning,
    ).toBeNull()
    expect(byId.get('zai-org/GLM-5.3')?.factSources?.pricing?.sourceUrl).toBe(
      BASETEN_PRICING_URL,
    )
    expect(models.some((model) => model.rawId === 'other/nope')).toBe(false)
  })

  it('throws when the overview or the pricing section is missing', () => {
    expect(() => parseBasetenCatalog(pages({ overview: 'no table' }))).toThrow(
      /overview listed no model slugs|overview context/,
    )
    expect(() =>
      parseBasetenCatalog(pages({ pricingHtml: '<p>contact sales</p>' })),
    ).toThrow(/per-1M-token/)
  })

  it('reads only Baseten docs and OpenAPI', async () => {
    const urls: Array<string> = []
    globalThis.fetch = ((url: string) => {
      urls.push(String(url))
      const body =
        String(url) === BASETEN_OVERVIEW_URL
          ? OVERVIEW
          : String(url) === BASETEN_REASONING_URL
            ? REASONING
            : String(url) === BASETEN_VISION_URL
              ? VISION
              : String(url) === BASETEN_PRICING_URL
                ? PRICING
                : String(url) === BASETEN_CHAT_OPENAPI_URL
                  ? JSON.stringify(SPEC)
                  : String(url) === BASETEN_MESSAGES_OPENAPI_URL
                    ? JSON.stringify(MESSAGES)
                    : null
      if (body === null) {
        return Promise.reject(new Error(`unexpected fetch: ${String(url)}`))
      }
      return Promise.resolve(new Response(body))
    }) as typeof fetch

    const listed = await provider.listModels({})
    const spec = await provider.fetchSpec({})

    expect(listed.models).toHaveLength(5)
    expect(listed.skipped).toBeUndefined()
    expect(spec.specs).toHaveLength(2)
    expect(spec.sources.map((source) => source.url)).toEqual([
      BASETEN_CHAT_OPENAPI_URL,
      BASETEN_MESSAGES_OPENAPI_URL,
    ])
    expect(provider.classify('/v1/chat/completions', {})).toBe('chat')
    expect(provider.classify('/v1/messages', {})).toBe('chat')
    expect(provider.classify('/v1/models', {})).toBeNull()
    expect(
      provider.generationEndpointId?.({
        rawId: 'zai-org/GLM-5.3',
        activity: 'chat',
      }),
    ).toBe('v1/chat/completions')
    expect(urls.some((url) => /models\.dev|openrouter/i.test(url))).toBe(false)
    expect(urls).toEqual([
      BASETEN_OVERVIEW_URL,
      BASETEN_REASONING_URL,
      BASETEN_VISION_URL,
      BASETEN_PRICING_URL,
      BASETEN_CHAT_OPENAPI_URL,
      BASETEN_MESSAGES_OPENAPI_URL,
    ])
  })
})
