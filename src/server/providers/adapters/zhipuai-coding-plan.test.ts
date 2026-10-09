import { expect, it } from 'vitest'
import { provider as zai } from './zai-coding-plan.ts'
import { provider as zhipu } from './zhipuai-coding-plan.ts'
import { ZAI_CODING_SOURCES, ZHIPU_CODING_SOURCES } from '../glm-coding.ts'

it('registers each Coding Plan with its own source and prevents general-schema binding', () => {
  for (const [provider, id, sources] of [
    [zai, 'zai-coding-plan', ZAI_CODING_SOURCES],
    [zhipu, 'zhipuai-coding-plan', ZHIPU_CODING_SOURCES],
  ] as const) {
    expect(provider.id).toBe(id)
    expect(provider.modelsEndpoint).toBe(sources.overview)
    expect(provider.specSourceUrl).toBe(sources.latest)
    expect(provider.bindSyncedRoutesOnly).toBe(true)
    expect(provider.classify('/chat/completions', {})).toBeNull()
    expect(provider.generationEndpointId).toBeUndefined()
  }
})
