import { describe, expect, it } from 'vitest'

import {
  modelsDevRateCard,
  modelsDevReasoning,
  normalizeModelsDevChat,
} from './models-dev.ts'

const SOURCE = {
  url: 'https://models.dev/api.json',
  hash: 'a'.repeat(64),
  extractedAt: '2026-10-03T00:00:00.000Z',
}

describe('normalizeModelsDevChat', () => {
  it('keeps chat facts and a per-million token card', () => {
    const model = normalizeModelsDevChat(
      {
        id: 'claude-opus',
        name: 'Claude Opus',
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
        tool_call: true,
        temperature: true,
        modalities: { input: ['text', 'image'], output: ['text'] },
        limit: { context: 200_000, output: 32_000 },
        cost: {
          input: 5,
          output: 25,
          cache_read: 0.5,
          tiers: [
            {
              input: 10,
              output: 37.5,
              cache_read: 1,
              tier: { type: 'context', size: 200_000 },
            },
          ],
        },
        provider: { npm: '@ai-sdk/anthropic' },
        release_date: '2026-05-28',
      },
      '@ai-sdk/openai-compatible',
      SOURCE,
    )
    expect(model).toMatchObject({
      rawId: 'claude-opus',
      activity: 'chat',
      contextWindow: 200_000,
      maxOutput: 32_000,
      modalities: { input: ['text', 'image'], output: ['text'] },
      capabilities: ['tools', 'temperature'],
      reasoning: { mode: 'effort', mandatory: true, efforts: ['low', 'high'] },
      schemaEndpointId: 'messages',
      releasedAt: Date.UTC(2026, 4, 28) / 1000,
    })
    const card = model?.pricing as {
      tables: {
        rate: { base: Record<string, number>; '200000': Record<string, number> }
      }
    }
    expect(card.tables.rate.base.input_tokens).toBe(5 / 1e6)
    expect(card.tables.rate.base.output_tokens).toBe(25 / 1e6)
    expect(card.tables.rate['200000'].input_tokens).toBe(10 / 1e6)
  })

  it('drops non-chat rows and unpublished prices', () => {
    expect(
      normalizeModelsDevChat(
        {
          id: 'flux',
          modalities: { input: ['text'], output: ['image'] },
          cost: { input: 1, output: 1 },
        },
        '@ai-sdk/openai-compatible',
        SOURCE,
      ),
    ).toBeNull()
    const free = normalizeModelsDevChat(
      {
        id: 'kimi-code',
        reasoning: false,
        modalities: { input: ['text'], output: ['text'] },
        limit: { context: 8000 },
        cost: { input: 0, output: 0, cache_read: 0 },
      },
      '@ai-sdk/openai-compatible',
      SOURCE,
    )
    expect(free?.pricing).toBeNull()
    expect(free?.reasoning).toBeNull()
    expect(free?.schemaEndpointId).toBe('chat/completions')
  })

  it('uses context_over_200k only when no context tier is listed', () => {
    const card = modelsDevRateCard(
      {
        input: 1,
        output: 2,
        context_over_200k: { input: 2, output: 4 },
      },
      SOURCE,
    )
    expect(card).not.toBeNull()
    if (!card) return
    const rate = card.tables.rate
    if (!rate || typeof rate === 'number') {
      throw new Error('expected a rate table')
    }
    const tier = rate['200000']
    if (typeof tier !== 'object') {
      throw new Error('expected a context tier')
    }
    expect(tier.output_tokens).toBe(4 / 1e6)
  })

  it('maps toggle and budget controls without inventing effort', () => {
    expect(
      modelsDevReasoning({
        reasoning: true,
        reasoning_options: [
          { type: 'toggle' },
          { type: 'budget_tokens', min: 1024 },
        ],
      }),
    ).toEqual({ mode: 'budget', mandatory: false })
    expect(
      modelsDevReasoning({
        reasoning: true,
        reasoning_options: [],
      }),
    ).toEqual({ mode: 'adaptive', mandatory: true })
  })
})
