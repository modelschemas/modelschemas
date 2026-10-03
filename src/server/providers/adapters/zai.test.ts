import { afterEach, describe, expect, it } from 'vitest'

import {
  MODELS_DEV_API_URL,
  clearModelsDevCatalogCache,
} from '../models-dev.ts'
import { provider } from './zai.ts'

const FIXTURE = {
  zai: {
    id: 'zai',
    npm: '@ai-sdk/openai-compatible',
    name: 'Z.AI',
    models: {
      'chat-model': {
        id: 'chat-model',
        name: 'Chat Model',
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
        tool_call: true,
        modalities: { input: ['text', 'image'], output: ['text'] },
        limit: { context: 128000, output: 4096 },
        cost: { input: 1.5, output: 3 },
      },
      'image-only': {
        id: 'image-only',
        modalities: { input: ['text'], output: ['image'] },
        cost: { input: 1, output: 1 },
      },
    },
  },
}

afterEach(() => {
  clearModelsDevCatalogCache()
  globalThis.fetch = fetch
})

describe('zai listModels', () => {
  it('lists models.dev chat rows with facts, price, and reasoning', async () => {
    const original = globalThis.fetch
    globalThis.fetch = ((url: string) => {
      if (String(url) === MODELS_DEV_API_URL) {
        return Promise.resolve(new Response(JSON.stringify(FIXTURE)))
      }
      return Promise.reject(new Error(`unexpected fetch: ${String(url)}`))
    }) as typeof fetch
    try {
      const result = await provider.listModels({})
      expect(result.skipped).toBeUndefined()
      expect(result.models.map((model) => model.rawId)).toEqual(['chat-model'])
      expect(result.models[0]).toMatchObject({
        activity: 'chat',
        contextWindow: 128000,
        maxOutput: 4096,
        modalities: { input: ['text', 'image'], output: ['text'] },
        reasoning: {
          mode: 'effort',
          mandatory: true,
          efforts: ['low', 'high'],
        },
      })
      expect(result.models[0]?.pricing).not.toBeNull()
    } finally {
      globalThis.fetch = original
    }
  })
})
