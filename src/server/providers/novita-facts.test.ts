import { price } from '@modelschemas/rate-card'
import type { RateCard } from '@modelschemas/rate-card'
import { describe, expect, it } from 'vitest'

import { novitaTieredCard } from './catalog-prices.ts'
import {
  applyNovitaDocs,
  parseNovitaChatDoc,
  parseNovitaFaqIds,
  parseNovitaProductModels,
  NOVITA_CHAT_DOC_URL,
  NOVITA_PRODUCT_MODELS_URL,
} from './novita-facts.ts'
import type { NovitaChatDoc, NovitaProductCatalog } from './novita-facts.ts'
import type { ModelInfo } from './types.ts'

const HASH = 'a'.repeat(64)
const MODELS_URL = 'https://api.novita.ai/openai/v1/models'

/** Excerpt of docs.novita.ai chat-completion markdown, 2026-10-08. */
const CHAT_DOC = `
<ParamField body="messages" type="object[]" required={true}>
    <ParamField body="role" type="string" required={true}>
      The role of the messages author. One of system, user, or assistant.
      Enum: \`system\`, \`user\`, \`assistant\`
    </ParamField>
</ParamField>
<ParamField body="max_tokens" type="integer" required={true}>
</ParamField>
<ParamField body="temperature" type="number | null" default={1}>
</ParamField>
<ParamField body="top_p" type="number | null">
</ParamField>
<ParamField body="top_k" type="integer | null">
</ParamField>
<ParamField body="stop" type="string | null">
</ParamField>
<ParamField body="seed" type="integer | null">
</ParamField>
<ParamField body="frequency_penalty" type="number | null" default={0}>
</ParamField>
<ParamField body="presence_penalty" type="number | null" default={0}>
</ParamField>
<ParamField body="tools" type="object[] | null">
    <ParamField body="type" type="string" required={true}>
    </ParamField>
</ParamField>
<ParamField body="enable_thinking" type="boolean | null" default={true}>
  Controls the switches between thinking and non-thinking modes.

  Supported models:

  * zai-org/glm-4.5
  * deepseek/deepseek-v3.1
  * deepseek/deepseek-v3.1-terminus
  * deepseek/deepseek-v3.2-exp
</ParamField>
`

/** Excerpt of docs.novita.ai/guides/LLM-FAQ.md, 2026-10-08. */
const FAQ = `
### How to control thinking function of zai-org/glm-4.5-air when calling its API?

\`\`\`python theme={"system"}
"enable_thinking": false
\`\`\`

\`\`\`python theme={"system"}
{
  "model": "zai-org/glm-4.5-air",
  "enable_thinking": false
}
\`\`\`

* **moonshotai/kimi-k2-instruct** and **zai-org/glm-4.5-air**: Add \`"enable_thinking": false\` to your request body.
* **MiniMax-M1**: Thinking mode **cannot currently be disabled** for this model.

\`\`\`python theme={"system"}
{
  "model": "moonshotai/kimi-k2-instruct",
  "enable_thinking": false
}
\`\`\`
`

const PRODUCT = {
  data: [
    {
      id: 'zai-org/glm-4.5-air',
      features_v2: [
        {
          name: 'function-calling',
          enabled: true,
          subFeatures: { tool_choice: true },
        },
        {
          name: 'structured-outputs',
          enabled: true,
          subFeatures: { json_object: true, json_schema: false },
        },
        {
          name: 'reasoning',
          enabled: true,
          subFeatures: { close: true },
        },
      ],
    },
    {
      id: 'zai-org/glm-5.3',
      features_v2: [
        {
          name: 'reasoning',
          enabled: true,
          subFeatures: { close: false },
        },
      ],
    },
    {
      id: 'moonshotai/kimi-k2-instruct',
      features_v2: [
        {
          name: 'function-calling',
          enabled: true,
          subFeatures: { tool_choice: true },
        },
        {
          name: 'reasoning',
          enabled: false,
          subFeatures: { close: true },
        },
      ],
    },
    { id: 'no-features' },
  ],
}

const MINIMAX_TIERS = [
  {
    min_tokens: 1,
    max_tokens: 524288,
    pricing: {
      prompt: { price_per_m_decimal: '0.3' },
      completion: { price_per_m_decimal: '1.2' },
      input_cache_read: { price_per_m_decimal: '0.06' },
    },
  },
  {
    min_tokens: 524288,
    max_tokens: 1000000,
    pricing: {
      prompt: { price_per_m_decimal: '0.6' },
      completion: { price_per_m_decimal: '2.4' },
      input_cache_read: { price_per_m_decimal: '0.12' },
    },
  },
]

const QWEN3_MAX_TIERS = [
  {
    min_tokens: 1,
    max_tokens: 32768,
    pricing: {
      prompt: { price_per_m_decimal: '0.845' },
      completion: { price_per_m_decimal: '3.38' },
    },
  },
  {
    min_tokens: 32768,
    max_tokens: 131072,
    pricing: {
      prompt: { price_per_m_decimal: '1.4' },
      completion: { price_per_m_decimal: '5.64' },
    },
  },
  {
    min_tokens: 131072,
    max_tokens: 258048,
    pricing: {
      prompt: { price_per_m_decimal: '2.11' },
      completion: { price_per_m_decimal: '8.45' },
    },
  },
]

function perMillion(card: RateCard, tokens: number): number {
  return (
    (price(card, {}, { input_tokens: tokens, output_tokens: 0 }) * 1e6) / tokens
  )
}

describe('novita chat doc', () => {
  it('reads max_tokens, the role enum, and the enable_thinking list', () => {
    const doc = parseNovitaChatDoc(CHAT_DOC, HASH)
    expect(doc.developerRole).toBe(false)
    expect(doc.flags).toEqual([
      'max_tokens',
      'temperature',
      'top_p',
      'top_k',
      'stop',
      'seed',
      'frequency_penalty',
      'presence_penalty',
    ])
    expect(doc.flags).not.toContain('tools')
    expect(doc.enableThinkingIds).toEqual([
      'zai-org/glm-4.5',
      'deepseek/deepseek-v3.1',
      'deepseek/deepseek-v3.1-terminus',
      'deepseek/deepseek-v3.2-exp',
    ])
  })

  it('treats enable_thinking with no model list as unrestricted', () => {
    const doc = parseNovitaChatDoc(
      CHAT_DOC.replace(
        /Supported models:[\s\S]*<\/ParamField>/,
        '</ParamField>',
      ),
      HASH,
    )
    expect(doc.enableThinkingIds).toBeNull()
  })

  it('throws when the spec names no ids or drops max_tokens', () => {
    expect(() =>
      parseNovitaChatDoc(
        CHAT_DOC.replace(
          /\* zai-org[\s\S]*\* deepseek\/deepseek-v3\.2-exp/,
          '',
        ),
        HASH,
      ),
    ).toThrow(/lists no models/)
    expect(() =>
      parseNovitaChatDoc(
        CHAT_DOC.replace('max_tokens', 'max_completion_tokens'),
        HASH,
      ),
    ).toThrow(/max_tokens is missing/)
    expect(() => parseNovitaChatDoc('{"data":[]}', HASH)).toThrow(/max_tokens/)
  })
})

describe('novita faq', () => {
  it('reads enable_thinking ids from fenced bodies and bold lines', () => {
    expect(parseNovitaFaqIds(FAQ, HASH).ids.sort()).toEqual([
      'moonshotai/kimi-k2-instruct',
      'zai-org/glm-4.5-air',
    ])
  })

  it('throws when no id is published', () => {
    expect(() => parseNovitaFaqIds('no thinking field', HASH)).toThrow(
      /parsed 0/,
    )
  })
})

describe('novita product models', () => {
  it('reads close, tool_choice, and json modes', () => {
    const catalog = parseNovitaProductModels(PRODUCT, HASH)
    expect(catalog.byId['zai-org/glm-4.5-air']).toEqual({
      tools: true,
      toolChoice: true,
      structured: { enabled: true, jsonSchema: false, jsonObject: true },
      reasoning: { enabled: true, close: true },
    })
    expect(catalog.byId['zai-org/glm-5.3']?.reasoning).toEqual({
      enabled: true,
      close: false,
    })
    expect(
      catalog.byId['moonshotai/kimi-k2-instruct']?.reasoning?.enabled,
    ).toBe(false)
    expect(catalog.byId['no-features']).toBeUndefined()
  })

  it('throws when the catalog has no feature rows', () => {
    expect(() => parseNovitaProductModels({ data: [] }, HASH)).toThrow(/empty/)
    expect(() =>
      parseNovitaProductModels({ data: [{ id: 'a' }, { id: 'a' }] }, HASH),
    ).toThrow(/duplicate/)
    expect(() =>
      parseNovitaProductModels({ data: [{ id: 'a' }] }, HASH),
    ).toThrow(/parsed 0/)
    expect(() =>
      parseNovitaProductModels(
        { data: [{ id: 'a', features_v2: { close: true } }] },
        HASH,
      ),
    ).toThrow(/not an array/)
  })
})

describe('novita tiered billing', () => {
  it('bills the lowest bracket and steps up past its min_tokens', async () => {
    const card = await novitaTieredCard(QWEN3_MAX_TIERS, MODELS_URL)
    expect(card).not.toBeNull()
    if (!card) return
    expect(perMillion(card, 1000)).toBeCloseTo(0.845, 9)
    expect(perMillion(card, 32768)).toBeCloseTo(0.845, 9)
    expect(perMillion(card, 32769)).toBeCloseTo(1.4, 9)
    expect(perMillion(card, 131073)).toBeCloseTo(2.11, 9)
  })

  it('keeps cache rates on the bracket that publishes them', async () => {
    const card = await novitaTieredCard(MINIMAX_TIERS, MODELS_URL)
    expect(card).not.toBeNull()
    if (!card) return
    expect(
      (price(
        card,
        {},
        {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 1000,
        },
      ) *
        1e6) /
        1000,
    ).toBeCloseTo(0.06, 9)
    expect(
      price(
        card,
        {},
        {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 524289,
        },
      ) *
        (1e6 / 524289),
    ).toBeCloseTo(0.12, 9)
  })

  it('returns null for an empty list and throws when a bracket is unreadable', async () => {
    expect(await novitaTieredCard(null, MODELS_URL)).toBeNull()
    expect(await novitaTieredCard([], MODELS_URL)).toBeNull()
    await expect(
      novitaTieredCard({ min_tokens: 1 }, MODELS_URL),
    ).rejects.toThrow(/not an array/)
    await expect(
      novitaTieredCard(
        [
          {
            min_tokens: 1,
            pricing: {
              prompt: { price_per_m_decimal: '1' },
              completion: { price_per_m_decimal: '2' },
              input_cache_read: { price_per_m_decimal: '0.1' },
            },
          },
          {
            min_tokens: 10,
            pricing: {
              prompt: { price_per_m_decimal: '2' },
              completion: { price_per_m_decimal: '4' },
            },
          },
        ],
        MODELS_URL,
      ),
    ).rejects.toThrow(/omits cache_read_tokens/)
  })
})

describe('applyNovitaDocs', () => {
  const chat = parseNovitaChatDoc(CHAT_DOC, HASH)
  const faqIds = parseNovitaFaqIds(FAQ, HASH).ids
  const product = parseNovitaProductModels(PRODUCT, HASH)

  function chatModel(partial: Partial<ModelInfo>): ModelInfo {
    return { rawId: 'missing', activity: 'chat', ...partial }
  }

  function applied(
    model: ModelInfo,
    docs?: Partial<{
      chat: NovitaChatDoc | null
      faqIds: Array<string> | null
      product: NovitaProductCatalog | null
    }>,
  ) {
    return applyNovitaDocs(model, {
      modelsUrl: MODELS_URL,
      chat,
      faqIds,
      product,
      ...docs,
    })
  }

  it('maps close and the enable_thinking wire only for ids the docs name', () => {
    const air = applied(
      chatModel({
        rawId: 'zai-org/glm-4.5-air',
        capabilities: [
          'tools',
          'reasoning',
          'structured_outputs',
          'response_format',
        ],
      }),
    )
    expect(air.reasoning).toEqual({ mode: 'toggle', mandatory: false })
    expect(air.requestMap?.thinking).toEqual({
      on: { enable_thinking: true },
      off: { enable_thinking: false },
      levels: null,
    })
    expect(air.requestMap?.maxTokensField).toBe('max_tokens')
    expect(air.requestMap?.developerRole).toBe(false)
    expect(air.capabilities).toEqual([
      'tools',
      'tool_choice',
      'reasoning',
      'response_format',
      'max_tokens',
      'temperature',
      'top_p',
      'top_k',
      'stop',
      'seed',
      'frequency_penalty',
      'presence_penalty',
    ])
    expect(air.exactCapabilities).toBe(true)
    expect(air.factSources?.reasoning).toMatchObject({
      derivation: 'listing',
      sourceUrl: NOVITA_PRODUCT_MODELS_URL,
      path: 'features_v2.reasoning.subFeatures.close',
    })
    expect(air.factSources?.requestMap).toMatchObject({
      derivation: 'docs-derived',
      sourceUrl: NOVITA_CHAT_DOC_URL,
      path: 'max_tokens',
    })

    const locked = applied(
      chatModel({
        rawId: 'zai-org/glm-5.3',
        capabilities: ['reasoning'],
      }),
    )
    expect(locked.reasoning).toEqual({ mode: 'toggle', mandatory: true })
    expect(locked.requestMap?.thinking).toBeNull()

    const kimi = applied(
      chatModel({
        rawId: 'moonshotai/kimi-k2-instruct',
        capabilities: ['tools'],
      }),
    )
    expect(kimi.reasoning).toBeUndefined()
    expect(kimi.capabilities).not.toContain('reasoning')
    expect(kimi.requestMap?.thinking?.off).toEqual({ enable_thinking: false })

    const disabled = applied(
      chatModel({
        rawId: 'paddlepaddle/paddleocr-vl',
        capabilities: ['tools', 'tool_choice'],
      }),
      {
        product: parseNovitaProductModels(
          {
            data: [
              {
                id: 'paddlepaddle/paddleocr-vl',
                features_v2: [
                  {
                    name: 'function-calling',
                    enabled: false,
                    subFeatures: { tool_choice: true },
                  },
                  {
                    name: 'structured-outputs',
                    enabled: false,
                    subFeatures: { json_object: true, json_schema: true },
                  },
                ],
              },
            ],
          },
          HASH,
        ),
      },
    )
    expect(disabled.capabilities).not.toContain('tools')
    expect(disabled.capabilities).not.toContain('tool_choice')
    expect(disabled.capabilities).not.toContain('response_format')
    expect(disabled.capabilities).not.toContain('structured_outputs')
  })

  it('keeps a stored fact when its source fails and skips non-chat rows', () => {
    const kept = applied(
      chatModel({ rawId: 'zai-org/glm-4.5-air', capabilities: ['tools'] }),
      { chat: null, product: null },
    )
    expect(kept.absent).toEqual({
      requestMap: 'unavailable',
      reasoning: 'unavailable',
    })
    expect(kept.requestMap).toBeUndefined()
    expect(kept.capabilities).toEqual(['tools'])

    const image = applied({ rawId: 'pic', activity: 'image' })
    expect(image.requestMap).toBeUndefined()
    expect(image.absent).toBeUndefined()
  })
})
