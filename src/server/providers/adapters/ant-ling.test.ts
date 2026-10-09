import { Validator } from '@cfworker/json-schema'
import { afterEach, expect, it } from 'vitest'
import { cardCurrency, price } from '@modelschemas/rate-card'
import { classifyAndBundle } from '../../ingest/sync.ts'
import fixtures from '../fixtures/ant-ling-docs.json'
import {
  ANT_OPENAI,
  ANT_PRICE,
  nativePrices,
  nativeRequest,
} from '../ant-ling-docs.ts'
import { provider } from './ant-ling.ts'

const native = fixtures as Record<string, string>
const originalFetch = globalThis.fetch
function serve(overrides: Record<string, string> = {}) {
  const urls: Array<string> = []
  globalThis.fetch = async (input) => {
    const url = String(input)
    urls.push(url)
    const body = overrides[url] ?? native[url]
    if (body === undefined) throw new Error(`unexpected source ${url}`)
    return new Response(body)
  }
  return urls
}
afterEach(() => {
  globalThis.fetch = originalFetch
})
it('refreshes direct IDs, CNY sale/free rates and hosted contexts without a key', async () => {
  const urls = serve()
  const fetched = await provider.listModels({})
  expect(fetched.skipped).toBeUndefined()
  expect(fetched.models).toHaveLength(8)
  const flagship = fetched.models.find((m) => m.rawId === 'Ling-2.6-1T')
  expect(flagship?.contextWindow).toBe(256000)
  expect(flagship?.pricing).toMatchObject({
    tables: {
      rate: {
        base: {
          input_tokens: 4.5 / 1e6,
          output_tokens: 18 / 1e6,
          cache_read_tokens: 0.9 / 1e6,
        },
      },
    },
  })
  const flash = fetched.models.find((m) => m.rawId === 'Ling-3.0-flash')
  expect(
    cardCurrency(flash?.pricing as Parameters<typeof cardCurrency>[0]),
  ).toBe('CNY')
  expect(flash?.pricing).toMatchObject({
    tables: {
      rate: {
        base: {
          input_tokens: 0.125 / 1e6,
          output_tokens: 0.375 / 1e6,
          cache_read_tokens: 0.025 / 1e6,
        },
      },
    },
  })
  const free = fetched.models.find((m) => m.rawId === 'Ling-3.1-flash')
  expect(price(free?.pricing as Parameters<typeof price>[0], {})).toBe(0)
  expect(
    fetched.models.find((m) => m.rawId === 'AntAngelMed')?.pricing,
  ).toBeNull()
  expect(
    fetched.models.find((m) => m.rawId === 'Ling-3.0-tiny')?.contextWindow,
  ).toBeNull()
  expect(fetched.models.every((m) => m.maxOutput === null)).toBe(true)
  expect(
    urls.every((url) =>
      url.startsWith('https://developer.ant-ling.com/en/docs/'),
    ),
  ).toBe(true)
})
it('keeps scoped native reasoning bodies and unknown max_tokens null', async () => {
  serve()
  const { models } = await provider.listModels({})
  const ring = models.find((m) => m.rawId === 'Ring-2.6-1T')
  expect(ring).toMatchObject({
    reasoning: { mode: 'effort', mandatory: null, efforts: ['high', 'xhigh'] },
    requestMap: {
      thinking: {
        on: { reasoning: { effort: 'high' } },
        off: null,
        levels: { high: 'high', xhigh: 'xhigh', medium: null },
      },
      maxTokensField: null,
    },
  })
  const flash = models.find((m) => m.rawId === 'Ling-3.0-flash')
  expect(flash?.requestMap?.thinking).toMatchObject({
    on: { thinking: { type: 'enabled' } },
    off: { thinking: { type: 'disabled' } },
  })
  expect(
    models.find((m) => m.rawId === 'Ling-2.6-1T')?.requestMap?.thinking,
  ).toBeNull()
  expect(
    models.find((m) => m.rawId === 'Ling-3.0-flash-VL')?.modalities,
  ).toEqual({ input: ['text', 'image', 'video'], output: ['text'] })
})
it('derives native parameter tables and nested constraints without borrowing a schema', async () => {
  serve()
  const fetched = await provider.fetchSpec({})
  const bundled = classifyAndBundle(provider, fetched)
  expect(bundled.endpoints).toHaveLength(1)
  expect(bundled.endpoints[0]?.input).toBeTruthy()
  expect(bundled.endpoints[0]?.output).toBeUndefined()
  const input = nativeRequest(native[ANT_OPENAI] ?? '')
  expect(
    (input.properties as Record<string, Record<string, unknown>>).model?.[
      'x-source-options'
    ],
  ).toContain('Ring-2.6-1T')
  expect(input).toMatchObject({
    required: ['model', 'messages'],
    properties: {
      temperature: { type: 'number', minimum: 0, maximum: 1 },
      top_p: { exclusiveMinimum: 0, maximum: 1 },
      messages: {
        items: {
          required: ['role', 'content'],
          properties: { role: { enum: ['system', 'user', 'assistant'] } },
        },
      },
    },
  })
  expect(
    (input.properties as Record<string, { enum?: unknown }>).model?.enum,
  ).toBeUndefined()
  expect(
    (input.properties as Record<string, unknown>).max_tokens,
  ).toBeUndefined()
})
it('ignores all reseller USD rows, including conflicting later rates', () => {
  const prices = nativePrices(native[ANT_PRICE] ?? '')
  expect(prices.get('Ling-2.6-1T')?.rates.input_tokens).toBe(4.5 / 1e6)
  expect(
    nativePrices((native[ANT_PRICE] ?? '').replace('$0.30', '$999999')).get(
      'Ling-2.6-1T',
    ),
  ).toEqual(prices.get('Ling-2.6-1T'))
})
it('fails missing sale amounts, missing price sections and changed field types', () => {
  const source = native[ANT_PRICE] ?? ''
  expect(() =>
    nativePrices(
      source.replace('<span>¥0.14</span>', '<span>unreadable</span>'),
    ),
  ).toThrow('unreadable current CNY price')
  expect(() =>
    nativePrices(source.replace('id="model-pricing"', 'id="changed-pricing"')),
  ).toThrow('missing model-pricing')
  expect(() =>
    nativeRequest(
      (native[ANT_OPENAI] ?? '').replace(
        '<code>double</code>',
        '<code>unknown-unit</code>',
      ),
    ),
  ).toThrow('unknown native field type')
})
it('fails an empty native catalog instead of silently retiring stored rows', async () => {
  serve({
    [ANT_OPENAI]: '<article><h2 id="request-body">Request Body</h2></article>',
  })
  await expect(provider.listModels({})).rejects.toThrow('missing native')
})

it('refreshes newly published model IDs and changes free rows to paid from source', async () => {
  serve({
    [ANT_OPENAI]: (native[ANT_OPENAI] ?? '').replaceAll(
      'AntAngelMed',
      'Native-New-ID',
    ),
  })
  const { models } = await provider.listModels({})
  expect(models.some((m) => m.rawId === 'Native-New-ID')).toBe(true)
  expect(models.some((m) => m.rawId === 'AntAngelMed')).toBe(false)
  const quotes = nativePrices(
    (native[ANT_PRICE] ?? '').replaceAll('¥0.00', '¥1.00'),
  )
  expect(quotes.get('Ling-3.1-flash')).toEqual({
    free: false,
    rates: {
      input_tokens: 1 / 1e6,
      output_tokens: 1 / 1e6,
      cache_read_tokens: 1 / 1e6,
    },
  })
})

it('keeps conflicting content shape unknown without fabricating block schemas', () => {
  const schema = nativeRequest(native[ANT_OPENAI] ?? '')
  const props = schema.properties as Record<string, Record<string, unknown>>
  const message = props.messages!.items as Record<string, unknown>
  const content = (
    message.properties as Record<string, Record<string, unknown>>
  ).content!
  expect(content.type).toBeUndefined()
  expect(content['x-source-type']).toBeNull()
  expect(content['x-source-declared-type']).toBe('string')
  expect(content['x-source-conflicting-statement']).toContain(
    'the request accepts text, images, and videos',
  )
  expect(content.items).toBeUndefined()
  const result = new Validator(schema).validate({
    model: 'Ling-3.0-flash-VL',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,example' },
          },
          { type: 'text', text: 'Describe' },
        ],
      },
    ],
  })
  expect(result.valid).toBe(true)
})
it('clears missing native prices and binds only API-documented models', async () => {
  serve()
  const models = (await provider.listModels({})).models
  expect(models).toHaveLength(8)
  for (const id of ['AntAngelMed', 'Ling-3.0-tiny']) {
    const m = models.find((m) => m.rawId === id)
    expect(m?.pricing).toBeNull()
    expect(m?.absent?.pricing).toBe('cleared')
  }
  const newlyPriced = models.find((m) => m.rawId === 'Ling-3.1-flash')
  expect(newlyPriced?.pricing).not.toBeNull()
  expect(newlyPriced?.activity).toBeNull()
  expect(newlyPriced?.schemaEndpointId).toBeNull()
  expect(newlyPriced?.requestMap).toBeNull()
  expect(newlyPriced?.factSources?.schemaEndpointId).toBeUndefined()
  const published = models.find((m) => m.rawId === 'Ling-3.0-flash-VL')
  expect(published?.schemaEndpointId).toBe('v1/chat/completions')
  expect(published?.factSources?.schemaEndpointId).toMatchObject({
    sourceUrl: ANT_OPENAI,
    path: 'Request Address + model.Options',
  })
  expect(provider.generationEndpointId).toBeUndefined()
  expect(provider.bindSyncedRoutesOnly).toBe(true)
})
