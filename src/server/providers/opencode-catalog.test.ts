import { describe, expect, it } from 'vitest'
import {
  OPENCODE_CATALOG_URL,
  parseOpenCodeCatalog,
} from './opencode-catalog.ts'

// Synthetic fixtures exercise catalog fields, never production model data.
function payload(extra: Record<string, unknown> = {}) {
  return {
    opencode: {
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
      opencode: { models: { synthetic: { id: 'synthetic' } } },
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
