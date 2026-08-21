import { describe, expect, expectTypeOf, it, vi } from 'vitest'

import { listProviderModels as listProviderModelsRaw } from './generated/sdk.gen'
import { listProviderModels } from './listed-model.ts'
import type { ListedModelId } from './listed-model.ts'

vi.mock('./generated/sdk.gen', () => ({
  getModel: vi.fn(),
  listModels: vi.fn(),
  listProviderModels: vi.fn(),
}))

describe('listProviderModels', () => {
  it('mints ListedModelId on rawId', async () => {
    vi.mocked(listProviderModelsRaw).mockResolvedValue({
      data: {
        models: [
          { id: 'anthropic-claude-sonnet-4-5', rawId: 'claude-sonnet-4-5' },
        ],
      },
      error: undefined,
    })
    const { data } = await listProviderModels({
      path: { provider: 'anthropic' },
    })
    expect(data?.models[0]?.rawId).toBe('claude-sonnet-4-5')
    expectTypeOf(data?.models[0]?.rawId).toEqualTypeOf<
      ListedModelId<'anthropic'> | undefined
    >()
  })
})
