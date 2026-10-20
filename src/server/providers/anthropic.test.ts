import { expect, it } from 'vitest'

import { ANTHROPIC_THINKING_URL } from './anthropic-features.ts'
import { ANTHROPIC_PRICING_URL } from './anthropic-pricing.ts'
import { anthropicProvider } from './anthropic.ts'
import { ANTHROPIC_MODELS_OVERVIEW_URL } from './provider-aliases.ts'

it('keeps the poll when the docs host serves pages with no tables', async () => {
  const original = globalThis.fetch
  globalThis.fetch = ((url: string) => {
    if (String(url).includes('platform.claude.com'))
      return Promise.resolve(new Response('# Docs\n\nNothing tabulated here.'))
    return Promise.resolve(
      new Response(
        JSON.stringify({
          data: [
            {
              id: 'claude-opus-5-5',
              display_name: 'Claude Opus 5.5',
              created_at: '2026-09-01T00:00:00Z',
              capabilities: {
                thinking: { types: { adaptive: { supported: true } } },
              },
            },
          ],
          has_more: false,
        }),
      ),
    )
  }) as typeof fetch
  try {
    const result = await anthropicProvider.listModels({
      ANTHROPIC_API_KEY: 'test-key',
    })
    const model = result.models[0]
    expect(model?.rawId).toBe('claude-opus-5-5')
    expect(model?.pricing).toBeUndefined()
    expect(model?.reasoning).toBeNull()
    expect(model?.serverTools).toContain('computer_toolset_20260801')
    expect(model?.absent).toEqual({
      pricing: 'unavailable',
      reasoning: 'unavailable',
      aliases: 'unavailable',
    })
    expect(
      result.docsFailures?.first.map((failure) => failure.source).sort(),
    ).toEqual(
      [
        ANTHROPIC_MODELS_OVERVIEW_URL,
        ANTHROPIC_PRICING_URL,
        ANTHROPIC_THINKING_URL,
      ].sort(),
    )
  } finally {
    globalThis.fetch = original
  }
})
