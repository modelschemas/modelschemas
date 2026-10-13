import { describe, expect, it } from 'vitest'
import {
  OPENCODE_CATALOG_URL,
  parseOpenCodeCatalog,
} from './opencode-catalog.ts'

// Synthetic fixtures exercise catalog fields, never production model data.
const EXTRACTED = '2026-10-13T00:00:00.000Z'
const HASH = 'a'.repeat(64)

function payload(extra: Record<string, unknown> = {}) {
  return {
    opencode: {
      npm: '@ai-sdk/openai-compatible',
      api: 'https://opencode.ai/inference/v1',
      models: {
        synthetic: {
          id: 'synthetic',
          limit: { context: 1234, output: 234 },
          modalities: { input: ['text', 'image'], output: ['text'] },
          tool_call: true,
          structured_output: false,
          reasoning: true,
          reasoning_options: [{ type: 'effort', values: ['none', 'high'] }],
          interleaved: { field: 'reasoning_content' },
          ...extra,
        },
      },
    },
  }
}
describe('OpenCode native catalog', () => {
  it('extracts only stated facts and records first-party provenance', () => {
    const model = parseOpenCodeCatalog(
      payload(),
      'opencode',
      'digest',
    ).synthetic
    expect(model).toMatchObject({
      contextWindow: 1234,
      maxOutput: 234,
      modalities: { input: ['text', 'image'], output: ['text'] },
      capabilities: {
        tools: true,
        structured_outputs: false,
        reasoning: true,
        vision: true,
      },
      reasoning: {
        mode: 'effort',
        mandatory: false,
        efforts: ['none', 'high'],
      },
      requestMap: {
        replayReasoningContent: true,
        thinking: null,
        developerRole: null,
      },
    })
    expect(model?.factSources?.contextWindow).toEqual({
      derivation: 'listing',
      sourceUrl: OPENCODE_CATALOG_URL,
      sourceHash: 'digest',
      path: 'opencode.models.synthetic.limit.context',
    })
  })
  it('does not infer mandatory thinking from an effort list without off', () => {
    expect(
      parseOpenCodeCatalog(
        payload({ reasoning_options: [{ type: 'effort', values: ['high'] }] }),
        'opencode',
        'h',
      ).synthetic?.reasoning?.mandatory,
    ).toBeNull()
  })
  it('recognizes budget plus toggle and leaves absent replay unknown', () => {
    const model = parseOpenCodeCatalog(
      payload({
        reasoning_options: [{ type: 'toggle' }, { type: 'budget_tokens' }],
        interleaved: undefined,
      }),
      'opencode',
      'h',
    ).synthetic
    expect(model?.reasoning).toEqual({ mode: 'budget', mandatory: false })
    expect(model?.requestMap).toBeNull()
  })
  it('leaves missing facts null rather than borrowing another provider', () => {
    const data = {
      opencode: {
        npm: '@ai-sdk/openai-compatible',
        api: 'https://opencode.ai/inference/v1',
        models: { synthetic: { id: 'synthetic' } },
      },
      unrelated: { models: payload().opencode.models },
    }
    expect(parseOpenCodeCatalog(data, 'opencode', 'h').synthetic).toMatchObject(
      {
        contextWindow: null,
        maxOutput: null,
        capabilities: null,
        modalities: null,
        reasoning: null,
        requestMap: null,
      },
    )
    expect(() => parseOpenCodeCatalog(data, 'opencode-go', 'h')).toThrow(
      /no provider/,
    )
  })
  it.each([
    { limit: { context: 'unknown' } },
    { modalities: { input: 'text', output: [] } },
    { tool_call: 'yes' },
    { reasoning_options: [{ type: 'effort', values: null }] },
    { interleaved: {} },
  ])('rejects malformed catalog facts %j', (fields) => {
    expect(() =>
      parseOpenCodeCatalog(payload(fields), 'opencode', 'h'),
    ).toThrow(/unreadable/)
  })
})

it('uses explicit catalog dates and weights with field provenance', () => {
  const model = parseOpenCodeCatalog(
    payload({
      release_date: '2026-09-22',
      knowledge: '2026-04',
      open_weights: false,
    }),
    'opencode',
    'hash',
  ).synthetic
  expect(model).toMatchObject({
    releasedAt: Date.UTC(2026, 8, 22) / 1000,
    knowledgeCutoff: '2026-04',
    openWeights: false,
  })
  expect(model?.providerMetadata?.release_date).toBe('2026-09-22')
  expect(model?.factSources?.knowledgeCutoff?.path).toBe(
    'opencode.models.synthetic.knowledge',
  )
  expect(model?.factSources?.openWeights?.path).toBe(
    'opencode.models.synthetic.open_weights',
  )
  const unknown = parseOpenCodeCatalog(payload(), 'opencode', 'hash').synthetic
  expect(unknown).toMatchObject({
    releasedAt: null,
    knowledgeCutoff: null,
    openWeights: null,
  })
})
it.each([
  { release_date: '2026-02-30' },
  { release_date: '2026-13-01' },
  { release_date: 123 },
  { knowledge: '2026-00' },
  { knowledge: '2026-02-30' },
  { knowledge: 'unknown' },
  { open_weights: 'true' },
])('rejects malformed sourced dates or weights %j', (fields) => {
  expect(() =>
    parseOpenCodeCatalog(payload(fields), 'opencode', 'hash'),
  ).toThrow(/unreadable/)
})

it('derives the route from the package, and Zen prices from cost', () => {
  const model = parseOpenCodeCatalog(
    payload({
      name: 'Synthetic',
      provider: { npm: '@ai-sdk/anthropic' },
      cost: {
        input: 4,
        output: 20,
        cache_read: 0.2,
        cache_write: 5,
        tiers: [
          {
            input: 8,
            output: 30,
            cache_read: 0.4,
            cache_write: 10,
            tier: { type: 'context', size: 272000 },
          },
        ],
        context_over_200k: {
          input: 8,
          output: 30,
          cache_read: 0.4,
          cache_write: 10,
        },
      },
    }),
    'opencode',
    HASH,
    EXTRACTED,
  ).synthetic
  expect(model).toMatchObject({
    displayName: 'Synthetic',
    activity: 'chat',
    schemaEndpointId: 'inference/v1/messages',
    factSources: {
      schemaEndpointId: {
        derivation: 'listing',
        sourceUrl: OPENCODE_CATALOG_URL,
        path: 'opencode.models.synthetic.provider.npm',
      },
      pricing: {
        derivation: 'listing',
        sourceUrl: OPENCODE_CATALOG_URL,
        path: 'opencode.models.synthetic.cost',
      },
    },
  })
  expect(
    (
      model?.pricing as {
        tables: { rate: Record<string, Record<string, number>> }
      }
    ).tables.rate,
  ).toEqual({
    base: {
      input_tokens: 4 / 1e6,
      output_tokens: 20 / 1e6,
      cache_read_tokens: 0.2 / 1e6,
      cache_write_tokens: 5 / 1e6,
    },
    '272000': {
      input_tokens: 8 / 1e6,
      output_tokens: 30 / 1e6,
      cache_read_tokens: 0.4 / 1e6,
      cache_write_tokens: 10 / 1e6,
    },
  })
})

it('uses the provider package when the model states none, and keeps an explicit zero', () => {
  const model = parseOpenCodeCatalog(
    payload({ cost: { input: 0, output: 0, cache_read: 0 } }),
    'opencode',
    HASH,
    EXTRACTED,
  ).synthetic
  expect(model?.schemaEndpointId).toBe('inference/v1/chat/completions')
  expect(model?.factSources?.schemaEndpointId?.path).toBe('opencode.npm')
  expect(model?.pricing).toMatchObject({ price: 0 })
})

it('leaves an unmapped package without a route', () => {
  const model = parseOpenCodeCatalog(
    payload({
      provider: { npm: '@ai-sdk/mistral' },
      cost: { input: 1, output: 2 },
    }),
    'opencode',
    HASH,
    EXTRACTED,
  ).synthetic
  expect(model?.schemaEndpointId).toBeUndefined()
  expect(model?.activity).toBeUndefined()
  expect(model?.pricing).toBeTruthy()
})

it('does not compile a Go price from cost', () => {
  const data = {
    'opencode-go': {
      npm: '@ai-sdk/openai-compatible',
      api: 'https://opencode.ai/inference/go/v1',
      models: {
        synthetic: {
          id: 'synthetic',
          provider: { npm: '@ai-sdk/openai' },
          cost: { input: 1, output: 2, cache_read: 0.1 },
        },
      },
    },
  }
  const model = parseOpenCodeCatalog(data, 'opencode-go', HASH).synthetic
  expect(model).toMatchObject({
    schemaEndpointId: 'v1/responses',
    activity: 'chat',
    factSources: {
      schemaEndpointId: { path: 'opencode-go.models.synthetic.provider.npm' },
    },
  })
  expect(model?.pricing).toBeUndefined()
})

it.each([
  { cost: { input: 1 } },
  { cost: { input: -1, output: 1 } },
  {
    cost: {
      input: 1,
      output: 2,
      cache_read: 0.1,
      tiers: [{ input: 3, output: 4, tier: { type: 'context', size: 1000 } }],
    },
  },
  {
    cost: {
      input: 1,
      output: 2,
      tiers: [{ input: 3, output: 4, tier: { type: 'context', size: 1000 } }],
      context_over_200k: { input: 9, output: 9 },
    },
  },
])('rejects an unreadable Zen cost %j', (fields) => {
  expect(() =>
    parseOpenCodeCatalog(payload(fields), 'opencode', HASH, EXTRACTED),
  ).toThrow(/opencode: /)
})
