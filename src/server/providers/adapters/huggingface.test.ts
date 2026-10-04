import { afterEach, describe, expect, it } from 'vitest'

import { HUGGINGFACE_MODELS_URL, provider } from './huggingface.ts'

/**
 * Excerpt of https://router.huggingface.co/v1/models (2026-10-04).
 * The nested provider price is another host's and must stay off this row.
 */
const FIXTURE = {
  object: 'list',
  data: [
    {
      id: 'Qwen/Qwen3.8-27B',
      created: 1785918179,
      architecture: {
        input_modalities: ['text', 'image'],
        output_modalities: ['text'],
      },
      providers: [{ provider: 'novita', pricing: { input: 0.42, output: 3 } }],
    },
    {
      id: 'black-forest-labs/FLUX.1-schnell',
      architecture: {
        input_modalities: ['text'],
        output_modalities: ['image'],
      },
    },
  ],
}

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('huggingface', () => {
  it('lists router ids and does not copy another provider price', async () => {
    const urls: Array<string> = []
    globalThis.fetch = ((url: string) => {
      urls.push(String(url))
      if (String(url) === HUGGINGFACE_MODELS_URL) {
        return Promise.resolve(new Response(JSON.stringify(FIXTURE)))
      }
      return Promise.reject(new Error(`unexpected fetch: ${String(url)}`))
    }) as typeof fetch

    const listed = await provider.listModels({})
    const spec = await provider.fetchSpec({})

    expect(listed.models.map((model) => model.rawId)).toEqual([
      'Qwen/Qwen3.8-27B',
      'black-forest-labs/FLUX.1-schnell',
    ])
    expect(listed.models[0]).toMatchObject({
      activity: 'chat',
      modalities: { input: ['text', 'image'], output: ['text'] },
      pricing: null,
      releasedAt: 1785918179,
    })
    expect(listed.models[1]).toMatchObject({
      activity: 'image',
      pricing: null,
    })
    expect(spec.skipped).toContain('skipped')
    expect(urls).toEqual([HUGGINGFACE_MODELS_URL])
  })
})
