import { expect, it } from 'vitest'

import {
  ANTHROPIC_THINKING_URL,
  anthropicServerTools,
} from './anthropic-features.ts'
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
    expect(result.models).toHaveLength(1)
    const model = result.models[0]
    expect(model?.rawId).toBe('claude-opus-5-5')
    expect(model?.pricing).toBeUndefined()
    expect(model?.reasoning).toBeNull()
    const tools = anthropicServerTools('claude-opus-5-5').serverTools
    expect(tools.length).toBeGreaterThan(0)
    expect(model?.serverTools).toEqual(tools)
    expect(model?.absent).toEqual({
      pricing: 'unavailable',
      reasoning: 'unavailable',
      aliases: 'unavailable',
    })
    for (const failure of result.docsFailures?.first ?? []) {
      expect(failure.error).toMatch(/parsed 0 model rows$/)
    }
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

const OVERVIEW_LINKS = [
  'https://platform.claude.com/docs/en/about-claude/model-deprecations',
  'https://platform.claude.com/docs/en/models/claude-opus-5-5/overview',
].join('\n')

it('loads the docs through the US egress, like the listing (#482)', async () => {
  const original = globalThis.fetch
  globalThis.fetch = ((url: string) =>
    Promise.reject(
      new Error(`global fetch called for ${String(url)}`),
    )) as typeof fetch
  const egressed: Array<string> = []
  const ns = {
    idFromName: () => 'id',
    get: () => ({
      fetch(url: string) {
        egressed.push(String(url))
        if (url === ANTHROPIC_MODELS_OVERVIEW_URL)
          return Promise.resolve(new Response(OVERVIEW_LINKS))
        if (url.includes('platform.claude.com'))
          return Promise.resolve(new Response('# Docs'))
        return Promise.resolve(Response.json({ data: [], has_more: false }))
      },
    }),
  }
  try {
    const result = await anthropicProvider.listModels({
      ANTHROPIC_API_KEY: 'test-key',
      US_EGRESS: ns as unknown as DurableObjectNamespace,
    })
    for (const failure of result.docsFailures?.first ?? []) {
      expect(failure.error).not.toMatch(/global fetch called/)
    }
    expect(egressed).toEqual(
      expect.arrayContaining([
        ANTHROPIC_PRICING_URL,
        ANTHROPIC_THINKING_URL,
        ANTHROPIC_MODELS_OVERVIEW_URL,
        // The alias map's follow-up loads: deprecations and a model page.
        'https://platform.claude.com/docs/en/about-claude/model-deprecations.md',
        'https://platform.claude.com/docs/en/models/claude-opus-5-5/overview.md',
      ]),
    )
  } finally {
    globalThis.fetch = original
  }
})
