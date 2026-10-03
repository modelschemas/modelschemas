import { describe, expect, it } from 'vitest'

import { price } from '@modelschemas/rate-card'
import type { RateCard } from '@modelschemas/rate-card'

import { provider as cerebras } from './adapters/cerebras.ts'
import { provider as deepseek } from './adapters/deepseek.ts'
import { dashscopeListedModel } from './adapters/dashscope.ts'
import { provider as fireworks } from './adapters/fireworks.ts'
import { provider as hyperbolic } from './adapters/hyperbolic.ts'
import { provider as jina } from './adapters/jina.ts'
import { provider as moonshot } from './adapters/moonshot.ts'
import { provider as novita } from './adapters/novita.ts'
import { provider as perplexity } from './adapters/perplexity.ts'
import { provider as sambanova } from './adapters/sambanova.ts'
import { parseDeepseekPricing } from './deepseek-pricing.ts'
import { parseFireworksPricing } from './fireworks-pricing.ts'
import { parseMoonshotPricing } from './moonshot-pricing.ts'
import {
  cerebrasCatalogRows,
  parseCerebrasModelPage,
} from './cerebras-pricing.ts'

const DEEPSEEK_HTML = `
<table>
<tr><td>MODEL</td><td>deepseek-flash</td><td>deepseek-v4-pro</td></tr>
<tr><td>PRICING</td></tr>
<tr><td>OFF-PEAK</td><td>$0.003</td><td>$0.022</td></tr>
<tr><td>PEAK</td><td>$0.006</td><td>$0.044</td></tr>
<tr><td>OFF-PEAK</td><td>$0.15</td><td>$0.66</td></tr>
<tr><td>PEAK</td><td>$0.3</td><td>$1.32</td></tr>
<tr><td>OFF-PEAK</td><td>$0.6</td><td>$1.98</td></tr>
<tr><td>PEAK</td><td>$1.2</td><td>$3.96</td></tr>
<tr><td>Concurrency Limit</td><td>2500</td><td>500</td></tr>
</table>`

const FIREWORKS_MD = `
| Model | Standard | Priority |
| - | - | - |
| [DeepSeek V4.1 Flash](https://app.fireworks.ai/models/fireworks/deepseek-v4p1-flash) | $0.30 / $0.006 / $1.20 | $0.375 / $0.0075 / $1.50 |
| [DeepSeek V4.1 Flash (US)](https://app.fireworks.ai/models/fireworks/deepseek-v4p1-flash) | $0.45 / $0.009 / $1.80 | $0.56 / $0.01 / $2.25 |
| [Kimi K3 Fast](https://app.fireworks.ai/models/fireworks/kimi-k3) | $4.50 / $0.45 / $22.50 | — |
| Less than 4B parameters | $0.10 |
`

const MOONSHOT_MD = `
["kimi-k2.6", "1M tokens", <>{"$"}0.16</>, <>{"$"}0.95</>, <>{"$"}4.00</>, "262,144 tokens"],
["kimi-k3", "1M tokens", <>{"$"}3.00</>, <>{"$"}6.00</>, <>{"$"}0.30</>, <>{"$"}3.00</>, <>{"$"}15.00</>, "1,048,576 tokens"],
`

const CEREBRAS_CATALOG = `
| [OpenAI GPT OSS](/models/openai-oss) | \`gpt-oss-120b\` | 120 billion |
`

const CEREBRAS_PAGE = `
<ModelInfo
  modelId="gpt-oss-120b"
  pricing={{
    inputPrice: "$0.35 / M tokens",
    outputPrice: "$0.75 / M tokens"
  }}
  inputOutput={{
    inputFormats: ["text"],
    outputFormats: ["text"]
  }}
  features={[
    "Reasoning",
    "Tool Calling"
  ]}
  contextLength={{
    paidTiers: "131k tokens"
  }}
/>
`

function inputUsd(card: unknown): number {
  return price(card as RateCard, {}, { input_tokens: 1e6, output_tokens: 0 })
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

async function withFetch(
  handler: (url: string) => Response,
  run: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch
  globalThis.fetch = ((url: string) =>
    Promise.resolve(handler(String(url)))) as typeof fetch
  try {
    await run()
  } finally {
    globalThis.fetch = original
  }
}

describe('deepseek pricing page', () => {
  it('keeps the off-peak rate and drops a model the table does not name', () => {
    const parsed = parseDeepseekPricing(DEEPSEEK_HTML)
    expect(parsed.get('deepseek-flash')).toEqual({
      cacheRead: 0.003,
      input: 0.15,
      output: 0.6,
    })
    expect(parsed.get('deepseek-v4-pro')?.input).toBe(0.66)
    expect(parsed.has('deepseek-chat')).toBe(false)
  })
})

describe('fireworks pricing page', () => {
  it('maps standard cells, skips US and size bands, and splits fast routers', () => {
    const parsed = parseFireworksPricing(FIREWORKS_MD)
    expect(parsed.get('accounts/fireworks/models/deepseek-v4p1-flash')).toEqual(
      { input: 0.3, cacheRead: 0.006, output: 1.2 },
    )
    expect(parsed.get('accounts/fireworks/routers/kimi-k3-fast')?.input).toBe(
      4.5,
    )
    expect(parsed.size).toBe(2)
  })
})

describe('moonshot pricing page', () => {
  it('reads K2 cache columns and K3 cache-write columns', () => {
    const parsed = parseMoonshotPricing(MOONSHOT_MD)
    expect(parsed.get('kimi-k2.6')).toEqual({
      cacheRead: 0.16,
      input: 0.95,
      output: 4,
    })
    expect(parsed.get('kimi-k3')?.cacheWrite).toBe(3)
    expect(parsed.get('kimi-k3')?.cacheWrite1h).toBe(6)
  })
})

describe('cerebras model pages', () => {
  it('reads the catalog link and the ModelInfo price', () => {
    expect(cerebrasCatalogRows(CEREBRAS_CATALOG)).toEqual([
      { slug: 'openai-oss', id: 'gpt-oss-120b' },
    ])
    const facts = parseCerebrasModelPage(CEREBRAS_PAGE)
    expect(facts?.inputPerMillion).toBe(0.35)
    expect(facts?.outputPerMillion).toBe(0.75)
    expect(facts?.modalities).toEqual({ input: ['text'], output: ['text'] })
    expect(facts?.capabilities).toEqual(['reasoning', 'tools'])
  })
})

describe('issue #109 listModels', () => {
  it('sets deepseek activity and an off-peak card, and leaves an unpriced id null', async () => {
    await withFetch(
      (url) => {
        if (url.includes('api.deepseek.com/models')) {
          return json({
            data: [
              {
                id: 'deepseek-flash',
                output_modalities: ['text'],
                input_modalities: ['text', 'image'],
                effort: { supported_levels: ['high'] },
              },
              { id: 'deepseek-other' },
            ],
          })
        }
        if (url.includes('quick_start/pricing')) {
          return new Response(DEEPSEEK_HTML, { status: 200 })
        }
        return new Response('missing', { status: 404 })
      },
      async () => {
        const { models } = await deepseek.listModels({
          DEEPSEEK_API_KEY: 'test',
        })
        const flash = models.find((model) => model.rawId === 'deepseek-flash')
        const other = models.find((model) => model.rawId === 'deepseek-other')
        expect(flash?.activity).toBe('chat')
        expect(flash?.modalities).toEqual({
          input: ['text', 'image'],
          output: ['text'],
        })
        expect(flash?.pricing).toBeTruthy()
        expect(inputUsd(flash?.pricing)).toBeCloseTo(0.15, 9)
        expect(other?.activity).toBeNull()
        expect(other?.pricing ?? null).toBeNull()
      },
    )
  })

  it('prices a cerebras chat row from its model page and leaves an unlisted id null', async () => {
    await withFetch(
      (url) => {
        if (url.includes('api.cerebras.ai')) {
          return json({
            data: [{ id: 'gpt-oss-120b' }, { id: 'not-on-the-page' }],
          })
        }
        if (url.endsWith('/models/overview.md')) {
          return new Response(CEREBRAS_CATALOG, { status: 200 })
        }
        if (url.endsWith('/models/openai-oss.md')) {
          return new Response(CEREBRAS_PAGE, { status: 200 })
        }
        return new Response('missing', { status: 404 })
      },
      async () => {
        const { models } = await cerebras.listModels({
          CEREBRAS_API_KEY: 'test',
        })
        const priced = models.find((model) => model.rawId === 'gpt-oss-120b')
        const bare = models.find((model) => model.rawId === 'not-on-the-page')
        expect(priced?.activity).toBe('chat')
        expect(priced?.modalities).toEqual({
          input: ['text'],
          output: ['text'],
        })
        expect(inputUsd(priced?.pricing)).toBeCloseTo(0.35, 9)
        expect(bare?.activity).toBe('chat')
        expect(bare?.pricing ?? null).toBeNull()
      },
    )
  })

  it('prices moonshot from the docs table and keeps a zero quote null', async () => {
    await withFetch(
      (url) => {
        if (url.includes('api.moonshot.ai')) {
          return json({
            data: [
              {
                id: 'kimi-k2.6',
                supports_image_in: true,
                supports_video_in: false,
                supports_reasoning: true,
                context_length: 262144,
              },
              { id: 'kimi-free' },
            ],
          })
        }
        if (url.includes('pricing/chat.md')) {
          return new Response(MOONSHOT_MD, { status: 200 })
        }
        return new Response('missing', { status: 404 })
      },
      async () => {
        const { models } = await moonshot.listModels({
          MOONSHOT_API_KEY: 'test',
        })
        const kimi = models.find((model) => model.rawId === 'kimi-k2.6')
        const free = models.find((model) => model.rawId === 'kimi-free')
        expect(kimi?.activity).toBe('chat')
        expect(kimi?.modalities).toEqual({
          input: ['text', 'image'],
          output: ['text'],
        })
        expect(kimi?.capabilities).toEqual(['reasoning'])
        expect(inputUsd(kimi?.pricing)).toBeCloseTo(0.95, 9)
        expect(free?.activity).toBe('chat')
        expect(free?.pricing ?? null).toBeNull()
      },
    )
  })

  it('prices a fireworks chat row and leaves a reranker and a missing price null', async () => {
    await withFetch(
      (url) => {
        if (url.includes('api.fireworks.ai')) {
          return json({
            data: [
              {
                id: 'accounts/fireworks/models/deepseek-v4p1-flash',
                kind: 'HF_BASE_MODEL',
                supports_chat: true,
                supports_image_input: true,
                supports_tools: true,
              },
              {
                id: 'accounts/fireworks/models/qwen3-reranker-8b',
                kind: 'HF_BASE_MODEL',
                supports_chat: true,
              },
              {
                id: 'accounts/fireworks/models/unpriced',
                kind: 'HF_BASE_MODEL',
                supports_chat: true,
                supports_image_input: false,
              },
            ],
          })
        }
        if (url.includes('serverless/pricing.md')) {
          return new Response(FIREWORKS_MD, { status: 200 })
        }
        return new Response('missing', { status: 404 })
      },
      async () => {
        const { models } = await fireworks.listModels({
          FIREWORKS_API_KEY: 'test',
        })
        const chat = models.find((model) => model.rawId.includes('deepseek'))
        const rerank = models.find((model) => model.rawId.includes('reranker'))
        const bare = models.find((model) => model.rawId.includes('unpriced'))
        expect(chat?.activity).toBe('chat')
        expect(chat?.modalities).toEqual({
          input: ['text', 'image'],
          output: ['text'],
        })
        expect(chat?.capabilities).toEqual(['tools'])
        expect(inputUsd(chat?.pricing)).toBeCloseTo(0.3, 9)
        expect(rerank?.activity).toBeNull()
        expect(rerank?.pricing ?? null).toBeNull()
        expect(bare?.activity).toBe('chat')
        expect(bare?.pricing ?? null).toBeNull()
      },
    )
  })

  it('compiles a novita decimal and leaves a tiered row null', async () => {
    await withFetch(
      () =>
        json({
          data: [
            {
              id: 'zai-org/glm',
              model_type: 'chat',
              input_modalities: ['text'],
              output_modalities: ['text'],
              features: ['function-calling'],
              pricing: {
                prompt: { price_per_m_decimal: '0.15' },
                completion: { price_per_m_decimal: '0.5' },
              },
            },
            {
              id: 'tiered',
              model_type: 'chat',
              is_tiered_billing: true,
              pricing: {
                prompt: { price_per_m_decimal: '1' },
                completion: { price_per_m_decimal: '2' },
              },
            },
          ],
        }),
      async () => {
        const { models } = await novita.listModels({ NOVITA_API_KEY: 'test' })
        const chat = models.find((model) => model.rawId === 'zai-org/glm')
        const tiered = models.find((model) => model.rawId === 'tiered')
        expect(chat?.activity).toBe('chat')
        expect(chat?.capabilities).toContain('tools')
        expect(inputUsd(chat?.pricing)).toBeCloseTo(0.15, 9)
        expect(tiered?.activity).toBe('chat')
        expect(tiered?.pricing ?? null).toBeNull()
      },
    )
  })

  it('compiles perplexity per-million quotes and rejects an untagged unit', async () => {
    await withFetch(
      () =>
        json({
          data: [
            {
              id: 'perplexity/sonar',
              pricing: { input: 1, output: 1, unit: 'usd_per_1m_tokens' },
            },
            {
              id: 'mystery',
              pricing: { input: 1, output: 1, unit: 'credits' },
            },
          ],
        }),
      async () => {
        const { models } = await perplexity.listModels({
          PERPLEXITY_API_KEY: 'test',
        })
        const sonar = models.find((model) => model.rawId === 'perplexity/sonar')
        const mystery = models.find((model) => model.rawId === 'mystery')
        expect(sonar?.activity).toBe('chat')
        expect(inputUsd(sonar?.pricing)).toBeCloseTo(1, 9)
        expect(
          perplexity.generationEndpointId?.({
            rawId: 'perplexity/sonar',
            activity: 'chat',
          }),
        ).toBe('v1/sonar')
        expect(mystery?.pricing ?? null).toBeNull()
      },
    )
  })

  it('sets jina activity from output modalities and skips an all-zero price', async () => {
    await withFetch(
      () =>
        json({
          data: [
            {
              id: 'jina-embeddings-v3',
              output_modalities: ['embeddings'],
              input_modalities: ['text'],
              pricing: { prompt: '0.00000005', completion: '0' },
            },
            {
              id: 'jina-reranker-v3',
              output_modalities: ['text'],
              input_modalities: ['text'],
              pricing: { prompt: '0', completion: '0' },
            },
          ],
        }),
      async () => {
        const { models } = await jina.listModels({ JINA_API_KEY: 'test' })
        const embed = models.find((model) => model.rawId.includes('embeddings'))
        const rerank = models.find((model) => model.rawId.includes('reranker'))
        expect(embed?.activity).toBe('embeddings')
        expect(inputUsd(embed?.pricing)).toBeCloseTo(0.05, 9)
        expect(rerank?.activity).toBeNull()
        expect(rerank?.pricing ?? null).toBeNull()
      },
    )
  })

  it('prices sambanova per token and leaves a zero quote null', async () => {
    await withFetch(
      () =>
        json({
          data: [
            {
              id: 'DeepSeek-V3.2',
              context_length: 32768,
              pricing: { prompt: '0.00000300', completion: '0.00000450' },
            },
            {
              id: 'free',
              pricing: { prompt: '0', completion: '0' },
            },
          ],
        }),
      async () => {
        const { models } = await sambanova.listModels({
          SAMBANOVA_API_KEY: 'test',
        })
        const chat = models.find((model) => model.rawId === 'DeepSeek-V3.2')
        const free = models.find((model) => model.rawId === 'free')
        expect(chat?.activity).toBe('chat')
        expect(chat?.contextWindow).toBe(32768)
        expect(inputUsd(chat?.pricing)).toBeCloseTo(3, 9)
        expect(free?.pricing ?? null).toBeNull()
      },
    )
  })

  it('prices hyperbolic per million tokens from the listing', async () => {
    await withFetch(
      () =>
        json({
          data: [
            {
              id: 'deepseek-ai/DeepSeek-R1',
              supports_chat: true,
              supports_image_input: false,
              supports_tools: false,
              input_price: 2,
              output_price: 2,
            },
            {
              id: 'no-price',
              supports_chat: true,
              supports_image_input: false,
            },
          ],
        }),
      async () => {
        const { models } = await hyperbolic.listModels({
          HYPERBOLIC_API_KEY: 'test',
        })
        const chat = models.find((model) => model.rawId.includes('DeepSeek'))
        const bare = models.find((model) => model.rawId === 'no-price')
        expect(chat?.activity).toBe('chat')
        expect(chat?.modalities).toEqual({
          input: ['text'],
          output: ['text'],
        })
        expect(inputUsd(chat?.pricing)).toBeCloseTo(2, 9)
        expect(bare?.activity).toBe('chat')
        expect(bare?.pricing ?? null).toBeNull()
      },
    )
  })

  it('maps a dashscope chat row to a card and leaves a zero quote null', async () => {
    const priced = await dashscopeListedModel({
      model: 'qwen3-max',
      name: 'Qwen3-Max',
      capabilities: ['TG'],
      features: ['function-calling'],
      inference_metadata: {
        request_modality: ['Text'],
        response_modality: ['Text'],
      },
      prices: [
        {
          range_name: 'Default',
          prices: [
            {
              type: 'input_token',
              price: '2',
              price_unit: 'Per 1M tokens',
            },
            {
              type: 'output_token',
              price: '6',
              price_unit: 'Per 1M tokens',
            },
          ],
        },
      ],
    })
    const free = await dashscopeListedModel({
      model: 'decision-model-preview',
      capabilities: ['TG'],
      inference_metadata: {
        request_modality: ['Text'],
        response_modality: ['Text'],
      },
      prices: [
        {
          range_name: 'Default',
          prices: [
            { type: 'input_token', price: '0', price_unit: 'Per 1M tokens' },
          ],
        },
      ],
    })
    expect(priced?.activity).toBe('chat')
    expect(priced?.modalities).toEqual({ input: ['text'], output: ['text'] })
    expect(priced?.capabilities).toEqual(['tools'])
    expect(inputUsd(priced?.pricing)).toBeCloseTo(2, 9)
    expect(free?.activity).toBe('chat')
    expect(free?.pricing ?? null).toBeNull()
  })
})
