import { afterEach, describe, expect, it } from 'vitest'

import { provider, VERCEL_MODELS_URL } from './vercel.ts'

/**
 * Excerpt of https://ai-gateway.vercel.sh/v1/models (2026-10-04).
 * `pricing` values are the gateway's USD-per-token strings.
 */
const FIXTURE = {
  object: 'list',
  data: [
    {
      id: 'alibaba/qwen-3-14b',
      name: 'Qwen3-14B',
      type: 'language',
      context_window: 40960,
      max_tokens: 16384,
      modalities: { input: ['text'], output: ['text'] },
      reasoning_options: [{ type: 'toggle' }],
      pricing: { input: '0.00000012', output: '0.00000024' },
      released: 1745798400,
    },
    {
      id: 'alibaba/qwen-3-235b',
      name: 'Qwen3-235B',
      type: 'language',
      modalities: { input: ['text'], output: ['text'] },
      reasoning_options: [
        { type: 'toggle' },
        { type: 'effort', values: ['none', 'low', 'medium', 'high'] },
      ],
      pricing: { input: '0.00000018' },
    },
    {
      id: 'google/imagen',
      type: 'image',
      modalities: { input: ['text'], output: ['image'] },
    },
  ],
}

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('vercel', () => {
  it('lists gateway models from the Vercel payload and skips the spec', async () => {
    const urls: Array<string> = []
    globalThis.fetch = ((url: string) => {
      urls.push(String(url))
      if (String(url) === VERCEL_MODELS_URL) {
        return Promise.resolve(new Response(JSON.stringify(FIXTURE)))
      }
      return Promise.reject(new Error(`unexpected fetch: ${String(url)}`))
    }) as typeof fetch

    const listed = await provider.listModels({})
    const spec = await provider.fetchSpec({})

    expect(listed.skipped).toBeUndefined()
    expect(listed.models.map((model) => model.rawId)).toEqual([
      'alibaba/qwen-3-14b',
      'alibaba/qwen-3-235b',
      'google/imagen',
    ])
    expect(listed.models[0]).toMatchObject({
      displayName: 'Qwen3-14B',
      activity: 'chat',
      contextWindow: 40960,
      maxOutput: 16384,
      modalities: { input: ['text'], output: ['text'] },
      reasoning: null,
      releasedAt: 1745798400,
    })
    expect(listed.models[0]?.pricing).toMatchObject({
      tables: {
        rate: {
          base: { input_tokens: 0.00000012, output_tokens: 0.00000024 },
        },
      },
    })
    expect(listed.models[1]?.pricing).toBeNull()
    expect(listed.models[1]?.reasoning).toEqual({
      mode: 'effort',
      mandatory: false,
      efforts: ['none', 'low', 'medium', 'high'],
    })
    expect(listed.models[2]).toMatchObject({
      activity: 'image',
      pricing: null,
    })
    expect(spec.skipped).toContain('skipped')
    expect(spec.specs).toEqual([])
    expect(urls).toEqual([VERCEL_MODELS_URL])
  })
})
