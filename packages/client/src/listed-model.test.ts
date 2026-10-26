import { evaluateCard } from '@modelschemas/rate-card/evaluator'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'

import {
  getModel as getModelRaw,
  listProviderModels as listProviderModelsRaw,
} from './generated/sdk.gen'
import type { Model } from './generated/types.gen'
import { getModel, listProviderModels } from './listed-model.ts'
import type { ListedModelId } from './listed-model.ts'

vi.mock('./generated/sdk.gen', () => ({
  getModel: vi.fn(),
  listModels: vi.fn(),
  listProviderModels: vi.fn(),
}))

const link = { href: '/v1', method: 'GET' as const, contentType: 'json' }
const row: Model = {
  id: 'anthropic-claude-sonnet-4-5',
  provider: 'anthropic',
  rawId: 'claude-sonnet-4-5',
  sameAs: null,
  activity: 'chat',
  displayName: null,
  schemaEndpointId: null,
  contextWindow: null,
  maxOutput: null,
  modalities: null,
  pricing: null,
  pricingRange: null,
  capabilities: { tools: true },
  providerMetadata: null,
  reasoning: null,
  serverTools: null,
  requestMap: null,
  requiredRequestHeaders: null,
  trainsOnRequestData: null,
  aliases: null,
  releasedAt: null,
  knowledgeCutoff: null,
  openWeights: null,
  weightsUrl: null,
  firstSeenAt: 1,
  lastSeenAt: 1,
  deprecatedAt: null,
  deprecation: null,
  _links: { provider: link, schemas: link },
}

describe('listProviderModels', () => {
  it('mints ListedModelId on rawId and keeps the typed row', async () => {
    vi.mocked(listProviderModelsRaw).mockResolvedValue({
      data: {
        provider: 'anthropic',
        count: 1,
        models: [row],
        _links: { provider: link, schemas: link },
      },
      error: undefined,
      request: new Request('https://example.com'),
      response: new Response(),
    })
    const { data } = await listProviderModels({
      path: { provider: 'anthropic' },
    })
    expect(data?.models[0]?.rawId).toBe('claude-sonnet-4-5')
    expectTypeOf(data?.models[0]?.rawId).toEqualTypeOf<
      ListedModelId<'anthropic'> | undefined
    >()
    expectTypeOf(data?.models[0]?.capabilities).toEqualTypeOf<
      { [key: string]: boolean } | null | undefined
    >()
  })
})

describe('getModel', () => {
  it('keeps detail discrepancies on the branded row', async () => {
    vi.mocked(getModelRaw).mockResolvedValue({
      data: { ...row, discrepancies: [] },
      error: undefined,
      request: new Request('https://example.com'),
      response: new Response(),
    })
    const { data } = await getModel({
      path: { provider: 'anthropic', modelId: 'claude-sonnet-4-5' },
    })
    expect(data?.discrepancies).toEqual([])
    expectTypeOf(data?.provider).toEqualTypeOf<'anthropic' | undefined>()
  })
})

describe('getModel pricing', () => {
  it('narrows to a card evaluateCard accepts with no cast', async () => {
    const { data } = await getModel({
      path: { provider: 'anthropic', modelId: 'claude-sonnet-4-5' },
    })
    if (data?.pricing && 'price' in data.pricing) {
      expectTypeOf(evaluateCard)
        .parameter(0)
        .toMatchTypeOf<NonNullable<typeof data.pricing>>()
    }
  })
})
