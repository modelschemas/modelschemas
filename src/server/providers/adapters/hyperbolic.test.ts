import { describe, expect, it } from 'vitest'

import { chatRequestMap } from '../request-map.ts'
import { provider } from './hyperbolic.ts'

/** Live `GET https://api.hyperbolic.xyz/v1/models` on 2026-10-07. `created` is the poll clock, not a release date. */
const LISTING = {
  object: 'list',
  data: [
    {
      id: 'deepseek-ai/DeepSeek-V3-0324',
      created: 1791366236,
      object: 'model',
      owned_by: 'Hyperbolic',
      number_of_inference_nodes: null,
      supports_chat: true,
      supports_image_input: false,
      supports_tools: false,
      context_length: 163840,
      input_price: 1.25,
      output_price: 1.25,
    },
    {
      id: 'meta-llama/Llama-3.3-70B-Instruct',
      created: 1791366236,
      object: 'model',
      owned_by: 'Hyperbolic',
      number_of_inference_nodes: null,
      supports_chat: true,
      supports_image_input: false,
      supports_tools: false,
      context_length: 131072,
      input_price: 0.4,
      output_price: 0.4,
    },
    {
      id: 'deepseek-ai/DeepSeek-R1',
      created: 1791366236,
      object: 'model',
      owned_by: 'Hyperbolic',
      number_of_inference_nodes: null,
      supports_chat: true,
      supports_image_input: false,
      supports_tools: false,
      context_length: 163840,
      input_price: 2,
      output_price: 2,
    },
    {
      id: 'deepseek-ai/DeepSeek-R1-0528',
      created: 1791366236,
      object: 'model',
      owned_by: 'Hyperbolic',
      number_of_inference_nodes: null,
      supports_chat: true,
      supports_image_input: false,
      supports_tools: false,
      context_length: 163840,
      input_price: 3,
      output_price: 3,
    },
    {
      id: 'Qwen/Qwen3-Coder-480B-A35B-Instruct',
      created: 1791366236,
      object: 'model',
      owned_by: 'Hyperbolic',
      number_of_inference_nodes: null,
      supports_chat: true,
      supports_image_input: false,
      supports_tools: true,
      context_length: 262144,
      input_price: 2,
      output_price: 2,
    },
  ],
}

describe('hyperbolic classify', () => {
  it('maps chat completions and drops platform paths', () => {
    expect(provider.classify('/chat/completions', {})).toBe('chat')
    expect(provider.classify('/v1/chat/completions', {})).toBe('chat')
    expect(provider.classify('/files', {})).toBeNull()
    expect(provider.classify('/v1/models', {})).toBeNull()
    expect(provider.classify('/fine_tuning/jobs', {})).toBeNull()
  })
})

describe('hyperbolic listModels', () => {
  it('skips when the secret is absent', async () => {
    const result = await provider.listModels({})
    expect(result.models).toEqual([])
    expect(result.skipped).toBe(
      'hyperbolic: HYPERBOLIC_API_KEY not set — skipped',
    )
  })

  it('reads tools from supports_tools and leaves unpublished caps off the row', async () => {
    const original = globalThis.fetch
    globalThis.fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify(LISTING), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
    try {
      const { models } = await provider.listModels({
        HYPERBOLIC_API_KEY: 'test',
      })
      expect(models.map((model) => model.rawId)).toEqual(
        LISTING.data.map((row) => row.id),
      )
      for (const model of models) {
        expect(model.activity).toBe('chat')
        expect(model.maxOutput ?? null).toBeNull()
        expect(model.modalities).toEqual({ input: ['text'], output: ['text'] })
        expect(model.exactCapabilities).toBe(true)
        const base = (
          model.pricing as {
            tables: { rate: { base: Record<string, number> } }
          }
        ).tables.rate.base
        expect(Object.keys(base).sort()).toEqual([
          'input_tokens',
          'output_tokens',
        ])
        expect(
          chatRequestMap('hyperbolic', model.rawId, model.activity),
        ).toBeNull()
      }
      const qwen = models.find((model) => model.rawId.startsWith('Qwen/'))
      expect(qwen?.contextWindow).toBe(262144)
      expect(qwen?.capabilities).toEqual(['tools'])
      expect(qwen?.factSources?.capabilities?.tools).toEqual({
        derivation: 'listing',
        sourceUrl: 'https://api.hyperbolic.xyz/v1/models',
        path: 'supports_tools',
      })
      const silent = models.filter((model) => !model.rawId.startsWith('Qwen/'))
      expect(silent).toHaveLength(4)
      for (const model of silent) {
        expect(model.capabilities).toEqual([])
        expect(model.factSources?.capabilities).toBeUndefined()
      }
      expect(
        models.find((model) => model.rawId === 'deepseek-ai/DeepSeek-R1')
          ?.contextWindow,
      ).toBe(163840)
    } finally {
      globalThis.fetch = original
    }
  })
})
