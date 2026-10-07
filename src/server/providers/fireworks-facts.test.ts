import { describe, expect, it } from 'vitest'

import { price } from '@modelschemas/rate-card'
import type { RateCard } from '@modelschemas/rate-card'

import chatSpec from './fixtures/fireworks-chat-spec.json'
import serverlessBody from './fixtures/fireworks-serverless.json'
import {
  applyFireworksDocs,
  FIREWORKS_SERVERLESS_URL,
  FIREWORKS_SPEC_URL,
  matchFireworksFamily,
  mergeFireworksRates,
  parseFireworksChatSpec,
  parseFireworksServerless,
} from './fireworks-facts.ts'
import { FIREWORKS_PRICING_URL } from './fireworks-pricing.ts'
import type { FireworksChatSpec, FireworksFamily } from './fireworks-facts.ts'
import type { ModelInfo } from './types.ts'

const HASH = 'ab'.repeat(32)
const WHEN = '2026-10-08T00:00:00.000Z'
const LEVELS = ['none', 'low', 'medium', 'high', 'xhigh', 'max']

const spec = parseFireworksChatSpec(chatSpec)

function familyFor(rawId: string): FireworksFamily | null {
  return matchFireworksFamily(rawId, spec.families)
}

function chat(rawId: string, extra: Partial<ModelInfo> = {}): ModelInfo {
  return { rawId, activity: 'chat', capabilities: ['tools'], ...extra }
}

describe('fireworks chat spec', () => {
  it('reads the shared chat request and each named family', () => {
    expect(spec.shared).toEqual({
      maxTokensField: 'max_tokens',
      developerRole: false,
      replayReasoningContent: true,
      sessionAffinity: true,
    })
    expect(spec.families).toHaveLength(12)

    const qwen = familyFor('accounts/fireworks/models/qwen3p8-max')
    expect(qwen?.tokens).toEqual(
      expect.arrayContaining(['qwen3p8', 'qwen3p8-max']),
    )
    expect(qwen?.reasoning).toEqual({
      mode: 'effort',
      mandatory: false,
      efforts: LEVELS,
    })
    expect(qwen?.thinking.levels).toMatchObject({
      off: 'none',
      low: 'low',
      high: 'high',
      xhigh: 'xhigh',
      max: 'max',
      minimal: null,
    })
    expect(qwen?.thinking.off).toEqual({ reasoning_effort: 'none' })

    const wide = familyFor('accounts/fireworks/models/qwen3p8-2p4t-a95b')
    expect(wide?.tokens).toContain('qwen3p8')
    expect(wide?.tokens).not.toContain('qwen3')

    const other = spec.families.find((family) =>
      family.tokens.includes('qwen3'),
    )
    expect(other?.tokens).toEqual(expect.arrayContaining(['qwen3', 'qwen3p5']))
    expect(other?.tokens).not.toContain('qwen3-no-thinking')
    expect(other?.reasoning.efforts).toEqual(['none', 'low', 'medium', 'high'])

    expect(
      familyFor('accounts/fireworks/models/minimax-m2')?.reasoning,
    ).toEqual({
      mode: 'effort',
      mandatory: true,
      efforts: ['low', 'medium', 'high'],
    })
    expect(
      familyFor('accounts/fireworks/models/minimax-m2')?.thinking.off,
    ).toBeNull()

    expect(
      familyFor('accounts/fireworks/models/deepseek-v3p1')?.reasoning,
    ).toEqual({
      mode: 'toggle',
      mandatory: false,
    })
    expect(
      familyFor('accounts/fireworks/models/deepseek-v3p1')?.thinking,
    ).toEqual({
      on: { reasoning_effort: true },
      off: { reasoning_effort: 'none' },
      levels: null,
    })

    const v41 = familyFor('accounts/fireworks/models/deepseek-v4p1-flash')
    expect(v41?.tokens).toContain('deepseek-v4p1')
    expect(v41?.tokens).not.toContain('deepseek-v4')
    expect(v41?.tokens).not.toContain('minimal')
    expect(v41?.tokens).not.toContain('ultra')
    expect(v41?.reasoning.efforts).toEqual(LEVELS)
    expect(
      familyFor('accounts/fireworks/models/deepseek-v4')?.tokens,
    ).toContain('deepseek-v4')
    expect(
      familyFor('accounts/fireworks/models/deepseek-v4')?.tokens,
    ).not.toContain('deepseek-v4p1')

    expect(
      familyFor('accounts/fireworks/models/glm-4p5-air')?.reasoning,
    ).toEqual({
      mode: 'toggle',
      mandatory: false,
    })
    expect(
      familyFor('accounts/fireworks/routers/glm-5p2-fast')?.reasoning,
    ).toEqual({
      mode: 'effort',
      mandatory: false,
      efforts: LEVELS,
    })
    expect(familyFor('accounts/fireworks/models/glm-5p3')).toBeNull()

    expect(
      familyFor('accounts/fireworks/routers/kimi-k3-fast')?.reasoning.efforts,
    ).toEqual(LEVELS)
    expect(familyFor('accounts/fireworks/models/ember-1')).toBeNull()

    const oss = familyFor('accounts/fireworks/models/gpt-oss-120b')
    expect(oss?.tokens).toEqual(
      expect.arrayContaining(['openai-gpt-oss-120b', 'gpt-oss-20b']),
    )
    expect(oss?.reasoning).toEqual({
      mode: 'effort',
      mandatory: true,
      efforts: ['low', 'medium', 'high'],
    })
    expect(oss?.thinking.on).toEqual({ reasoning_effort: 'high' })
    expect(
      familyFor('accounts/fireworks/models/gpt-oss-20b')?.reasoning.mandatory,
    ).toBe(true)

    const m3 = familyFor('accounts/fireworks/models/minimax-m3')
    expect(m3?.reasoning).toEqual({
      mode: 'adaptive',
      mandatory: null,
      efforts: ['adaptive'],
    })
    expect(m3?.thinking).toEqual({
      on: { thinking: { type: 'adaptive' } },
      off: null,
      levels: null,
    })
  })

  it('throws when the chat request or every family is missing', () => {
    expect(() => parseFireworksChatSpec({})).toThrow(/ChatCompletionRequest/)
    const empty: unknown = {
      components: {
        schemas: {
          ChatCompletionRequest: {
            properties: {
              reasoning_effort: {
                description:
                  'Model-specific behavior:\n- **Nope**: the prose names no control.',
              },
            },
          },
        },
      },
    }
    expect(() => parseFireworksChatSpec(empty)).toThrow(/0 reasoning families/)
  })
})

describe('fireworks serverless models', () => {
  const parsed = parseFireworksServerless(serverlessBody)

  it('prices standard and fast ids and skips priority, routers, and embeddings', () => {
    expect(parsed.rates.get('accounts/fireworks/routers/glm-5p2-fast')).toEqual(
      {
        input: 2.1,
        cacheRead: 0.21,
        output: 6.6,
      },
    )
    expect(parsed.rates.has('accounts/fireworks/models/glm-5p2')).toBe(false)
    expect(parsed.context.get('accounts/fireworks/routers/glm-5p2-fast')).toBe(
      1048576,
    )
    expect(parsed.rates.get('accounts/fireworks/models/inkling')).toEqual({
      input: 1,
      cacheRead: 0.17,
      output: 4.05,
    })
    expect(parsed.rates.get('accounts/fireworks/models/kimi-k3')).toEqual({
      input: 3,
      cacheRead: 0.3,
      output: 15,
    })
    expect(parsed.rates.has('firerouter/auto')).toBe(false)
    expect(parsed.rates.has('auto')).toBe(false)
    expect(
      parsed.rates.has('accounts/fireworks/models/qwen3-embedding-8b'),
    ).toBe(false)
    expect(parsed.context.has('accounts/fireworks/models/qwen3p8-max')).toBe(
      false,
    )
  })

  it('drops a billed id whose rows disagree and rejects an unreadable body', () => {
    const sku = (amount: string, name: string) => ({
      sku: name,
      amount,
      unit: '1M tokens',
    })
    const row = (amount: string, context: number) => ({
      id: 'accounts/fireworks/models/a',
      serverless_mode: 'standard',
      context_length: context,
      pricing: [
        sku(amount, 'LLM input tokens (uncached)'),
        sku('0.1', 'LLM input tokens (cached)'),
        sku('2', 'LLM output tokens'),
      ],
    })
    const disagreed = parseFireworksServerless({
      data: [row('1', 100), row('2', 200)],
    })
    expect(disagreed.rates.has('accounts/fireworks/models/a')).toBe(false)
    expect(disagreed.context.has('accounts/fireworks/models/a')).toBe(false)
    expect(
      parseFireworksServerless({
        data: [
          {
            id: 'accounts/fireworks/models/deepseek-v4p1-flash',
            kind: 'HF_BASE_MODEL',
            supports_chat: true,
          },
        ],
      }).rates.size,
    ).toBe(0)
    expect(() => parseFireworksServerless({ object: 'list' })).toThrow(
      /unreadable/,
    )
  })
})

describe('fireworks price merge', () => {
  const page = {
    input: 1,
    cacheRead: 0.1,
    output: 2,
  }

  it('keeps the pricing page when amounts match and drops a disagreement', () => {
    const merged = mergeFireworksRates(
      {
        rates: {
          'accounts/fireworks/models/a': page,
          'accounts/fireworks/models/b': page,
        },
        hash: HASH,
        extractedAt: WHEN,
      },
      {
        rates: {
          'accounts/fireworks/models/a': page,
          'accounts/fireworks/models/b': { ...page, output: 9 },
          'accounts/fireworks/models/c': page,
        },
        context: {},
        hash: HASH,
        extractedAt: WHEN,
      },
    )
    expect(merged?.['accounts/fireworks/models/a']?.sourceUrl).toBe(
      FIREWORKS_PRICING_URL,
    )
    expect(merged?.['accounts/fireworks/models/b']).toBeUndefined()
    expect(merged?.['accounts/fireworks/models/c']?.sourceUrl).toBe(
      FIREWORKS_SERVERLESS_URL,
    )
    expect(mergeFireworksRates(null, null)).toBeNull()
  })
})

describe('applyFireworksDocs', () => {
  const chatDoc: FireworksChatSpec & { hash: string } = { ...spec, hash: HASH }

  it('fills a named chat row and leaves an unnamed row without reasoning', () => {
    const named = applyFireworksDocs(
      chat('accounts/fireworks/models/qwen3p8-max'),
      {
        prices: {
          'accounts/fireworks/models/qwen3p8-max': {
            rates: { input: 2, cacheRead: 0.25, output: 6 },
            sourceUrl: FIREWORKS_PRICING_URL,
            sourceHash: HASH,
            extractedAt: WHEN,
          },
        },
        context: { 'accounts/fireworks/models/qwen3p8-max': 128 },
        contextHash: HASH,
        chat: chatDoc,
      },
    )
    expect(named.reasoning?.mode).toBe('effort')
    expect(named.capabilities).toEqual(['tools', 'reasoning'])
    expect(named.requestMap).toMatchObject({
      maxTokensField: 'max_tokens',
      developerRole: false,
      replayReasoningContent: true,
      sessionAffinity: true,
      reasoningEffort: true,
      store: null,
    })
    expect(named.contextWindow).toBe(128)
    expect(named.factSources?.contextWindow).toMatchObject({
      derivation: 'listing',
      sourceUrl: FIREWORKS_SERVERLESS_URL,
      path: 'context_length',
    })
    expect(named.factSources?.pricing?.sourceUrl).toBe(FIREWORKS_PRICING_URL)
    expect(named.factSources?.reasoning?.sourceUrl).toBe(FIREWORKS_SPEC_URL)
    expect(
      price(
        named.pricing as RateCard,
        {},
        { input_tokens: 1e6, output_tokens: 0 },
      ),
    ).toBeCloseTo(2)

    const kept = applyFireworksDocs(
      chat('accounts/fireworks/models/qwen3p8-max', { contextWindow: 5 }),
      {
        prices: {},
        context: { 'accounts/fireworks/models/qwen3p8-max': 128 },
        contextHash: HASH,
        chat: chatDoc,
      },
    )
    expect(kept.contextWindow).toBeUndefined()

    const ember = applyFireworksDocs(
      chat('accounts/fireworks/models/ember-1'),
      { prices: {}, context: {}, contextHash: null, chat: chatDoc },
    )
    expect(ember.reasoning).toBeUndefined()
    expect(ember.capabilities).toBeUndefined()
    expect(ember.requestMap?.reasoningEffort).toBeNull()
    expect(ember.requestMap?.thinking).toBeNull()
    expect(ember.requestMap?.maxTokensField).toBe('max_tokens')
  })

  it('marks a failed source unavailable and skips non-chat rows', () => {
    const missed = applyFireworksDocs(
      chat('accounts/fireworks/models/ember-1'),
      {
        prices: null,
        context: {},
        contextHash: null,
        chat: null,
      },
    )
    expect(missed.absent).toEqual({
      pricing: 'unavailable',
      reasoning: 'unavailable',
      requestMap: 'unavailable',
    })
    const embedding = applyFireworksDocs(
      {
        rawId: 'accounts/fireworks/models/qwen3-embedding-8b',
        activity: 'embeddings',
      },
      { prices: null, context: {}, contextHash: null, chat: null },
    )
    expect(embedding.absent).toEqual({ pricing: 'unavailable' })
    expect(embedding.requestMap).toBeUndefined()
  })
})
