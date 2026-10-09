import { DEEPSEEK_THINKING_URL } from '../provider-replay.ts'
import { DEEPSEEK_REPLAY_FIXTURE } from '../fixtures/provider-replay.ts'
import { describe, expect, it } from 'vitest'

import { provider } from './deepseek.ts'

describe('deepseek classify', () => {
  it('maps chat completions and drops platform paths', () => {
    expect(
      provider.classify('/chat/completions', {
        'x-modelschemas-deepseek-native': true,
      }),
    ).toBe('chat')
    expect(provider.classify('/chat/completions', {})).toBeNull()
    expect(provider.classify('/v1/chat/completions', {})).toBeNull()
    expect(provider.classify('/models', {})).toBeNull()
    expect(provider.classify('/files', {})).toBeNull()
    expect(provider.classify('/fine_tuning/jobs', {})).toBeNull()
  })
})

describe('deepseek listModels', () => {
  it('skips when the key is absent', async () => {
    const result = await provider.listModels({})
    expect(result.models).toEqual([])
    expect(result.skipped).toBe('deepseek: DEEPSEEK_API_KEY not set — skipped')
  })

  it('lists models when a key is present', async () => {
    const original = globalThis.fetch
    const urls: Array<string> = []
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      urls.push(String(url))
      if (String(url).includes('api-docs.deepseek.com')) {
        return Promise.resolve(
          new Response(
            [
              'MODEL',
              'deepseek-other',
              'PRICING',
              '$0.1',
              '$0.2',
              '$0.3',
              '$0.4',
              '$0.5',
              '$0.6',
              'Concurrency',
            ].join('\n'),
          ),
        )
      }
      const headers = new Headers(init?.headers)
      expect(headers.get('Authorization')).toBe('Bearer test-key')
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [{ id: 'deepseek-v4-pro', created: 1_700_000_000 }],
          }),
        ),
      )
    }) as typeof fetch
    try {
      const result = await provider.listModels({
        DEEPSEEK_API_KEY: 'test-key',
      })
      expect(urls[0]).toBe('https://api.deepseek.com/models')
      expect(result.skipped).toBeUndefined()
      expect(result.models).toEqual([
        {
          rawId: 'deepseek-v4-pro',
          releasedAt: 1_700_000_000,
          activity: null,
        },
      ])
    } finally {
      globalThis.fetch = original
    }
  })
})

it('sources DeepSeek effort and replay without losing other native capabilities', async () => {
  const original = globalThis.fetch
  globalThis.fetch = ((url: string) => {
    if (String(url) === DEEPSEEK_THINKING_URL)
      return Promise.resolve(new Response(DEEPSEEK_REPLAY_FIXTURE))
    if (String(url).includes('api-docs.deepseek.com'))
      return Promise.resolve(
        new Response(
          [
            'MODEL',
            'deepseek-v4-pro',
            'PRICING',
            '$1',
            '$2',
            '$3',
            '$4',
            '$5',
            '$6',
            'Concurrency',
          ].join('\n'),
        ),
      )
    return Promise.resolve(
      new Response(
        JSON.stringify({
          data: [
            {
              id: 'deepseek-v4-pro',
              output_modalities: ['text'],
              supports_tools: true,
              effort: { supported_levels: ['high', 'max'] },
            },
          ],
        }),
      ),
    )
  }) as typeof fetch
  try {
    const model = (await provider.listModels({ DEEPSEEK_API_KEY: 'test-key' }))
      .models[0]
    expect(model?.reasoning).toEqual({
      mode: 'effort',
      mandatory: null,
      efforts: ['high', 'max'],
    })
    expect(model?.capabilities).toEqual(
      expect.arrayContaining(['tools', 'reasoning']),
    )
    expect(model?.requestMap).toMatchObject({
      replayReasoningContent: true,
      thinking: null,
      developerRole: null,
    })
    expect(model?.factSources?.requestMap?.sourceUrl).toBe(
      DEEPSEEK_THINKING_URL,
    )
    expect(model?.pricing).not.toBeNull()
  } finally {
    globalThis.fetch = original
  }
})
