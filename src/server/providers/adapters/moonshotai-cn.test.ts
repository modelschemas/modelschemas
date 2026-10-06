import { afterEach, describe, expect, it } from 'vitest'

import { modelBranchSchemas, walkRequestSchema } from '../fact-sources.ts'
import specFixture from '../fixtures/moonshotai-cn-openapi.json' with { type: 'json' }
import type { OpenApiDocument } from '../types.ts'
import {
  MOONSHOT_CN_OPENAPI_URL,
  MOONSHOT_CN_PRICING_URL,
  moonshotCnChatFacts,
  parseMoonshotCnPricing,
  provider,
} from './moonshotai-cn.ts'

/** Excerpt of platform.kimi.com/docs/pricing/chat.md (2026-10-06). Prices are yuan. */
const PRICING = `
## 模型定价

### K3 系列模型

<DocTable
  columns={[
{ title: "模型", width: "12%" },
{ title: "计费单位", width: "10%" },
{ title: "缓存写入（TTL 5min）", width: "13%" },
{ title: "缓存写入（TTL 1h）", width: "13%" },
{ title: "输入价格（缓存命中）", width: "13%" },
{ title: "输入价格（缓存未命中）", width: "13%" },
{ title: "输出价格", width: "10%" },
{ title: "上下文窗口", width: "16%" },
]}
  rows={[
["kimi-k3", "1M tokens", "¥20.00", "¥40.00", "¥2.00", "¥20.00", "¥100.00", "1,048,576 tokens"],
]}
/>

### K2 系列模型

<DocTable
  columns={[
{ title: "模型", width: "24%" },
{ title: "计费单位", width: "12%" },
{ title: "输入价格（缓存命中）", width: "16%" },
{ title: "输入价格（缓存未命中）", width: "16%" },
{ title: "输出价格", width: "14%" },
{ title: "上下文窗口", width: "18%" },
]}
  rows={[
["kimi-k2.7-code", "1M tokens", "¥1.30", "¥6.50", "¥27.00", "262,144 tokens"],
["kimi-k2.7-code-highspeed", "1M tokens", "¥2.60", "¥13.00", "¥54.00", "262,144 tokens"],
["kimi-k2.6", "1M tokens", "¥1.10", "¥6.50", "¥27.00", "262,144 tokens"],
["kimi-unmapped", "1M tokens", "¥1.00", "¥2.00", "¥3.00", "8,192 tokens"],
]}
/>

## 计费基本概念
`

/** Chat path and its schema closure from platform.kimi.com/docs/openapi.json (2026-10-06). */
const SPEC = specFixture as OpenApiDocument

function mutated(edit: (spec: OpenApiDocument) => void): OpenApiDocument {
  const copy = structuredClone(SPEC)
  edit(copy)
  return copy
}

const originalFetch = globalThis.fetch

function stubFetch(spec: string): Array<string> {
  const urls: Array<string> = []
  globalThis.fetch = ((url: string) => {
    urls.push(String(url))
    if (String(url) === MOONSHOT_CN_PRICING_URL) {
      return Promise.resolve(new Response(PRICING))
    }
    if (String(url) === MOONSHOT_CN_OPENAPI_URL) {
      return Promise.resolve(new Response(spec))
    }
    return Promise.reject(new Error(`unexpected fetch: ${String(url)}`))
  }) as typeof fetch
  return urls
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('moonshotCnChatFacts', () => {
  it('reads each model from its own branch of the chat union', () => {
    const facts = moonshotCnChatFacts(SPEC, 'h')
    expect(Object.keys(facts)).toEqual([
      'kimi-k3',
      'kimi-k2.7-code',
      'kimi-k2.7-code-highspeed',
      'kimi-k2.6',
    ])
    expect(facts['kimi-k3']).toMatchObject({
      activity: 'chat',
      reasoning: {
        mode: 'effort',
        mandatory: true,
        efforts: ['low', 'high', 'max'],
      },
      // `reasoning_effort` alone says the model reasons; it has no `thinking`.
      capabilities: ['reasoning'],
      modalities: { input: ['text', 'image', 'video'], output: ['text'] },
    })
    const effortSource = {
      derivation: 'upstream-spec',
      sourceUrl: MOONSHOT_CN_OPENAPI_URL,
      sourceHash: 'h',
      path: '/components/schemas/KimiK3ChatRequest/properties/reasoning_effort',
    }
    expect(facts['kimi-k3']?.factSources.reasoning).toEqual(effortSource)
    expect(facts['kimi-k3']?.factSources.capabilities).toEqual({
      reasoning: effortSource,
    })
    // The K2 schemas take an on/off `thinking`; the walk flags that itself.
    for (const id of ['kimi-k2.7-code', 'kimi-k2.6']) {
      expect(facts[id]?.reasoning).toBeUndefined()
      expect(facts[id]?.capabilities).toBeUndefined()
      expect(facts[id]?.factSources.reasoning?.path).toBe('silent')
      expect(facts[id]?.modalities).toEqual({
        input: ['text', 'image', 'video'],
        output: ['text'],
      })
    }
    // "最大可设置为 1048576" is the context bound, not an output cap.
    for (const model of Object.values(facts)) {
      expect(model).not.toHaveProperty('maxOutput')
    }
  })

  it('claims no reasoning when the branch drops reasoning_effort', () => {
    const bare = mutated((spec) => {
      const k3 = spec.components?.schemas?.KimiK3ChatRequest as {
        allOf: Array<{ properties?: Record<string, unknown> }>
      }
      delete k3.allOf[1]?.properties?.reasoning_effort
    })
    const k3 = moonshotCnChatFacts(bare, 'h')['kimi-k3']
    expect(k3?.reasoning).toBeUndefined()
    expect(k3?.capabilities).toBeUndefined()
    expect(k3?.factSources.reasoning).toBeUndefined()
  })

  it('throws on another host’s spec or a chat body that is not a model union', () => {
    expect(() =>
      moonshotCnChatFacts(
        mutated((spec) => {
          spec.servers = [{ url: 'https://api.moonshot.ai' }]
        }),
        'h',
      ),
    ).toThrow(/spec server/)
    expect(() =>
      moonshotCnChatFacts(
        mutated((spec) => {
          const post = spec.paths?.['/v1/chat/completions']?.post as {
            requestBody: { content: Record<string, { schema: unknown }> }
          }
          post.requestBody.content['application/json'] = {
            schema: { $ref: '#/components/schemas/ChatRequestBase' },
          }
        }),
        'h',
      ),
    ).toThrow(/per-model union/)
  })
})

describe('moonshotai-cn', () => {
  it('lists chat rows with spec facts and prices them in yuan', async () => {
    const urls = stubFetch(JSON.stringify(SPEC))
    const { models } = await provider.listModels({})

    expect(urls).toEqual([MOONSHOT_CN_PRICING_URL, MOONSHOT_CN_OPENAPI_URL])
    expect(models.map((model) => model.rawId)).toEqual([
      'kimi-k3',
      'kimi-k2.7-code',
      'kimi-k2.7-code-highspeed',
      'kimi-k2.6',
      'kimi-unmapped',
    ])
    expect(models[0]).toMatchObject({
      rawId: 'kimi-k3',
      activity: 'chat',
      contextWindow: 1048576,
      capabilities: ['reasoning'],
      // ¥20 in, ¥100 out, ¥2 cache hit, ¥20 / ¥40 cache write per 1M.
      pricing: {
        price: { currency: ['CNY', expect.anything() as unknown] },
        tables: {
          rate: {
            base: {
              input_tokens: 20 / 1e6,
              output_tokens: 100 / 1e6,
              cache_read_tokens: 2 / 1e6,
              cache_write_tokens: 20 / 1e6,
              cache_write_1h_tokens: 40 / 1e6,
            },
          },
        },
        source: { url: MOONSHOT_CN_PRICING_URL },
      },
    })
    expect(models[0]?.factSources?.pricing).toMatchObject({
      derivation: 'docs-derived',
      sourceUrl: MOONSHOT_CN_PRICING_URL,
      sourceHash: expect.stringMatching(/^[0-9a-f]{64}$/) as string,
    })
    expect(models[0]?.maxOutput).toBeUndefined()
    expect(models[0]?.factSources?.contextWindow).toMatchObject({
      derivation: 'docs-derived',
      sourceUrl: MOONSHOT_CN_PRICING_URL,
    })
    for (const model of models) {
      expect(model.pricing).toMatchObject({
        price: { currency: ['CNY', expect.anything() as unknown] },
      })
    }
    // A priced id the chat spec does not map stays unclassified.
    expect(models[4]?.activity).toBeUndefined()
    expect(models[4]?.contextWindow).toBe(8192)
  })

  it('syncs the published spec and binds chat rows to its chat route', async () => {
    stubFetch(JSON.stringify(SPEC))
    const spec = await provider.fetchSpec({})
    expect(spec.skipped).toBeUndefined()
    expect(spec.sources[0]?.url).toBe(MOONSHOT_CN_OPENAPI_URL)
    expect(provider.classify('/v1/chat/completions', {})).toBe('chat')
    expect(provider.classify('/v1/files', {})).toBeNull()
    expect(
      provider.generationEndpointId?.({ rawId: 'kimi-k3', activity: 'chat' }),
    ).toBe('v1/chat/completions')
  })

  it('rejects a 200 that is a docs page, not the spec', async () => {
    stubFetch('<!doctype html><html><body>快速开始</body></html>')
    await expect(provider.fetchSpec({})).rejects.toThrow()
    await expect(provider.listModels({})).rejects.toThrow()
  })
})

describe('parseMoonshotCnPricing', () => {
  it('reads each column by its title', () => {
    const prices = parseMoonshotCnPricing(PRICING)
    expect([...prices.keys()]).toEqual([
      'kimi-k3',
      'kimi-k2.7-code',
      'kimi-k2.7-code-highspeed',
      'kimi-k2.6',
      'kimi-unmapped',
    ])
    expect(prices.get('kimi-k2.6')).toEqual({
      cache_read_tokens: 1.1 / 1e6,
      input_tokens: 6.5 / 1e6,
      output_tokens: 27 / 1e6,
    })
  })

  it.each([
    [
      'a unit suffix',
      '"¥6.50", "¥27.00", "262,144 tokens"],\n["kimi-unmapped"',
      '"¥6.50/千", "¥27.00", "262,144 tokens"],\n["kimi-unmapped"',
    ],
    ['a struck price', '"¥1.10"', '"~~¥2.20~~ ¥1.10"'],
    ['a dollar price', '"¥1.10"', '"$1.10"'],
    ['another unit', '["kimi-k2.6", "1M tokens"', '["kimi-k2.6", "1K tokens"'],
  ])('leaves a row with %s unpriced', (_name, from, to) => {
    const page = PRICING.replace(from, to)
    expect(page).not.toBe(PRICING)
    const prices = parseMoonshotCnPricing(page)
    expect(prices.has('kimi-k2.6')).toBe(false)
    expect(prices.has('kimi-k3')).toBe(true)
  })

  it('prices no row of a table with a column it does not know', () => {
    const page = PRICING.replace(
      '"输出价格", width: "14%"',
      '"输出价格（批量）", width: "14%"',
    )
    expect(page).not.toBe(PRICING)
    expect([...parseMoonshotCnPricing(page).keys()]).toEqual(['kimi-k3'])
  })

  it('never stores a batch table as the standard price', () => {
    const batch = PRICING.replace(
      '## 计费基本概念',
      `### 批量价格

<DocTable
  columns={[
{ title: "模型" },
{ title: "计费单位" },
{ title: "输入价格（缓存命中）" },
{ title: "输入价格（缓存未命中）" },
{ title: "输出价格" },
{ title: "上下文窗口" },
]}
  rows={[
["kimi-k2.6", "1M tokens", "¥0.55", "¥3.25", "¥13.50", "262,144 tokens"],
]}
/>

## 计费基本概念`,
    )
    expect(batch).not.toBe(PRICING)
    // Beside the standard row, and with the standard table retitled.
    expect(parseMoonshotCnPricing(batch).has('kimi-k2.6')).toBe(false)
    const retitled = batch.replace(
      '"输出价格", width: "14%"',
      '"输出价格（标准）", width: "14%"',
    )
    expect([...parseMoonshotCnPricing(retitled).keys()]).toEqual(['kimi-k3'])
    // The same tables outside `## 模型定价` are not prices at all.
    expect(() =>
      parseMoonshotCnPricing(PRICING.replace('## 模型定价', '## 批量定价')),
    ).toThrow('priced no ids')
  })

  it('refuses an id two rows price', () => {
    const page = PRICING.replace('"kimi-unmapped"', '"kimi-k3"')
    expect(parseMoonshotCnPricing(page).has('kimi-k3')).toBe(false)
  })

  it('throws when nothing is priced', () => {
    expect(() => parseMoonshotCnPricing(PRICING.replaceAll('¥', '$'))).toThrow(
      'moonshotai-cn: pricing page priced no ids',
    )
  })
})

describe('moonshotai-cn pricing page fetch', () => {
  it('refuses a page answered by another host', async () => {
    const response = new Response(PRICING)
    Object.defineProperty(response, 'url', {
      value: 'https://platform.kimi.ai/docs/pricing/chat.md',
    })
    globalThis.fetch = () => Promise.resolve(response)
    await expect(provider.listModels({})).rejects.toThrow(
      'answered by platform.kimi.ai',
    )
  })
})

describe('modelBranchSchemas', () => {
  it('walks one model’s branch, not the whole union', () => {
    const schemas = SPEC.components?.schemas ?? {}
    const body = SPEC.paths?.['/v1/chat/completions']?.post?.requestBody as {
      content: Record<string, { schema: Record<string, unknown> }>
    }
    // The stored shape: refs under `$defs`, the mapping left as published.
    const bundled: unknown = JSON.parse(
      JSON.stringify({
        ...body.content['application/json']?.schema,
        $defs: schemas,
      }).replaceAll('"$ref":"#/components/schemas/', '"$ref":"#/$defs/'),
    )
    const meta = { derivation: 'upstream-spec', endpointId: 'x' } as const
    const flags = Object.fromEntries(
      modelBranchSchemas(bundled).map(([rawId, branch]) => [
        rawId,
        walkRequestSchema(branch, meta)?.flags ?? [],
      ]),
    )
    expect(flags['kimi-k3']).toContain('reasoning_effort')
    expect(flags['kimi-k3']).not.toContain('reasoning')
    expect(flags['kimi-k2.6']).toContain('reasoning')
    expect(flags['kimi-k2.6']).not.toContain('reasoning_effort')
    expect(flags['kimi-k2.6']).toEqual(
      expect.arrayContaining(['tools', 'tool_choice', 'structured_outputs']),
    )
    expect(walkRequestSchema(bundled, meta)?.flags).toEqual(
      expect.arrayContaining(['reasoning', 'reasoning_effort']),
    )
    expect(modelBranchSchemas({ properties: { model: {} } })).toEqual([])
  })

  it('keeps the fields the union shares beside its branches', () => {
    const schema = {
      properties: { tools: {}, temperature: {} },
      allOf: [{ properties: { top_p: {} } }],
      oneOf: [{ $ref: '#/$defs/A' }, { $ref: '#/$defs/B' }],
      discriminator: {
        propertyName: 'model',
        mapping: { a: '#/components/schemas/A', b: '#/components/schemas/B' },
      },
      $defs: {
        A: { properties: { reasoning_effort: {} } },
        B: { properties: { thinking: {} } },
      },
    }
    const meta = { derivation: 'upstream-spec', endpointId: 'x' } as const
    const flags = Object.fromEntries(
      modelBranchSchemas(schema).map(([rawId, branch]) => [
        rawId,
        [...(walkRequestSchema(branch, meta)?.flags ?? [])].sort(),
      ]),
    )
    expect(flags).toEqual({
      a: ['reasoning_effort', 'temperature', 'tools', 'top_p'],
      b: ['reasoning', 'temperature', 'tools', 'top_p'],
    })
  })
})
