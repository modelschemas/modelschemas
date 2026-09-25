import { describe, expect, it } from 'vitest'

import {
  factDiscrepancies,
  fillFromOpenRouter,
  listingSources,
  mergeListingAndSchema,
  openRouterJoinIds,
  schemaRung,
  tagDocsFacts,
  walkRequestSchema,
} from './fact-sources.ts'

const chatSchema = {
  properties: {
    tools: { type: 'array' },
    tool_choice: { type: 'string' },
    temperature: { type: 'number' },
    top_p: { type: 'number' },
    max_tokens: { type: 'integer' },
    thinking: { type: 'object' },
    messages: {
      type: 'array',
      items: {
        properties: {
          content: {
            anyOf: [
              { type: 'string' },
              {
                type: 'array',
                items: {
                  properties: {
                    type: { enum: ['text', 'image'] },
                    image_url: { type: 'object' },
                  },
                },
              },
            ],
          },
        },
      },
    },
  },
}

describe('walkRequestSchema', () => {
  it('maps request properties to OpenRouter parameter names', () => {
    const walk = walkRequestSchema(chatSchema, {
      derivation: 'upstream-spec',
      endpointId: 'v1/messages',
      sourceUrl: 'https://api.anthropic.com/openapi.json',
    })
    expect(walk?.flags.sort()).toEqual(
      [
        'max_tokens',
        'reasoning',
        'temperature',
        'tool_choice',
        'tools',
        'top_p',
      ].sort(),
    )
    expect(walk?.sources.capabilities?.tools).toMatchObject({
      derivation: 'upstream-spec',
      endpointId: 'v1/messages',
      path: '/properties/tools',
    })
    expect(walk?.modalities?.input.sort()).toEqual(['image'])
    expect(walk?.modalities?.output).toEqual([])
  })

  it('walks Gemini generationConfig and responseSchema', () => {
    const walk = walkRequestSchema(
      {
        properties: {
          generationConfig: {
            properties: {
              temperature: { type: 'number' },
              topP: { type: 'number' },
              topK: { type: 'integer' },
              maxOutputTokens: { type: 'integer' },
              responseSchema: { type: 'object' },
            },
          },
          tools: { type: 'array' },
        },
      },
      {
        derivation: 'upstream-spec',
        endpointId: 'v1beta/models/{modelsId}:generateContent',
      },
    )
    expect(walk?.flags.sort()).toEqual(
      [
        'max_tokens',
        'response_format',
        'structured_outputs',
        'temperature',
        'tools',
        'top_k',
        'top_p',
      ].sort(),
    )
  })
})

describe('mergeListingAndSchema', () => {
  it('keeps listing flags and fills the rest from the schema', () => {
    const walk = walkRequestSchema(chatSchema, {
      derivation: 'upstream-spec',
      endpointId: 'v1/messages',
    })
    const merged = mergeListingAndSchema(
      {
        rawId: 'claude-sonnet-4-5',
        capabilities: ['reasoning', 'structured_outputs'],
        contextWindow: 200_000,
      },
      walk,
    )
    expect(merged.contextWindow).toBe(200_000)
    expect(merged.capabilities).toEqual(
      expect.arrayContaining([
        'reasoning',
        'structured_outputs',
        'tools',
        'temperature',
      ]),
    )
    expect(merged.factSources?.contextWindow?.derivation).toBe('listing')
    expect(merged.factSources?.capabilities?.reasoning?.derivation).toBe(
      'listing',
    )
    expect(merged.factSources?.capabilities?.tools?.derivation).toBe(
      'upstream-spec',
    )
  })

  it('does not turn a host-native capabilities object into flags', () => {
    const walk = walkRequestSchema(chatSchema, {
      derivation: 'upstream-spec',
      endpointId: 'x',
    })
    const merged = mergeListingAndSchema(
      { rawId: 'fal-ai/flux', capabilities: { category: 'text-to-image' } },
      walk,
    )
    expect(merged.capabilities).toEqual({ category: 'text-to-image' })
    expect(merged.factSources?.capabilities).toBeUndefined()
  })
})

describe('provenance helpers', () => {
  it('defaults untagged listing fields', () => {
    expect(listingSources({ rawId: 'x', contextWindow: 8_000 })).toEqual({
      contextWindow: { derivation: 'listing' },
    })
  })

  it('overlays provider tags on listing defaults', () => {
    expect(
      listingSources({
        rawId: 'x',
        contextWindow: 8_000,
        maxOutput: 4_000,
        factSources: { contextWindow: { derivation: 'docs-derived' } },
      }),
    ).toEqual({
      contextWindow: { derivation: 'docs-derived' },
      maxOutput: { derivation: 'listing' },
    })
  })

  it('tags docs facts per field', () => {
    const sources = tagDocsFacts(
      {
        contextWindow: 400_000,
        maxOutput: 128_000,
        modalities: { input: ['text'], output: ['text'] },
        capabilities: ['tools'],
      },
      'https://developers.openai.com/api/docs/models/gpt-5.md',
    )
    expect(sources.contextWindow?.derivation).toBe('docs-derived')
    expect(sources.capabilities?.tools?.path).toBe('capabilities.tools')
  })

  it('skips generated schemas at the rung check', () => {
    expect(schemaRung('generated')).toBeNull()
    expect(schemaRung('upstream-spec')).toBe('upstream-spec')
    expect(schemaRung(null)).toBeNull()
  })
})

describe('OpenRouter compare', () => {
  it('joins native ids onto OpenRouter slugs', () => {
    expect(openRouterJoinIds('openai', 'gpt-5-2025-08-07')).toEqual([
      'openai/gpt-5-2025-08-07',
      'openai/gpt-5',
    ])
    expect(
      openRouterJoinIds('anthropic', 'claude-sonnet-4-5-20250929'),
    ).toEqual([
      'anthropic/claude-sonnet-4-5-20250929',
      'anthropic/claude-sonnet-4-5',
      'anthropic/claude-sonnet-4.5',
    ])
    expect(openRouterJoinIds('grok', 'grok-4.6')).toEqual(['x-ai/grok-4.6'])
    expect(openRouterJoinIds('grok', 'grok-4.20-0309-non-reasoning')).toEqual([
      'x-ai/grok-4.20-0309-non-reasoning',
      'x-ai/grok-4.20',
    ])
    expect(openRouterJoinIds('grok', 'grok-4.20-multi-agent-0309')).toEqual([
      'x-ai/grok-4.20-multi-agent-0309',
      'x-ai/grok-4.20-multi-agent',
    ])
    expect(openRouterJoinIds('fal', 'x')).toEqual([])
  })

  it('fills a null maxOutput from OpenRouter, never a stated one', () => {
    const or = new Map([['x-ai/grok-4.7', 450_000]])
    const filled = fillFromOpenRouter(
      'grok',
      {
        rawId: 'grok-4.7',
        maxOutput: null,
        factSources: { contextWindow: { derivation: 'docs-derived' } },
      },
      or,
    )
    expect(filled.maxOutput).toBe(450_000)
    expect(filled.factSources).toEqual({
      contextWindow: { derivation: 'docs-derived' },
      maxOutput: {
        derivation: 'openrouter',
        sourceUrl: 'https://openrouter.ai/api/v1/models',
        path: 'x-ai/grok-4.7/top_provider/max_completion_tokens',
      },
    })
    const stated = { rawId: 'grok-4.7', maxOutput: 8_192 }
    expect(fillFromOpenRouter('grok', stated, or)).toBe(stated)
    const alias = fillFromOpenRouter(
      'mistral',
      { rawId: 'mistral-large-latest', aliasOf: 'mistral-large-2512' },
      new Map([['mistralai/mistral-large-2512', 262_144]]),
    )
    expect(alias.maxOutput).toBe(262_144)
    const unjoined = { rawId: 'grok-9', maxOutput: null }
    expect(fillFromOpenRouter('grok', unjoined, or)).toBe(unjoined)
  })

  it('reports flags we have that OpenRouter lacks, and the reverse', () => {
    const diffs = factDiscrepancies(
      {
        contextWindow: 200_000,
        maxOutput: 8_192,
        modalities: { input: ['text', 'image'], output: ['text'] },
        capabilities: ['tools', 'temperature'],
        factSources: {
          capabilities: { tools: { derivation: 'upstream-spec' } },
        },
      },
      {
        rawId: 'anthropic/claude-sonnet-4.5',
        contextWindow: 200_000,
        maxOutput: 8_192,
        modalities: { input: ['text'], output: ['text'] },
        capabilities: ['tools', 'top_p'],
      },
    )
    expect(diffs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'modalities',
          oursDerivation: null,
        }),
        expect.objectContaining({
          field: 'capabilities.temperature',
          ours: true,
          openrouter: false,
          oursDerivation: null,
        }),
        expect.objectContaining({
          field: 'capabilities.top_p',
          ours: false,
          openrouter: true,
        }),
      ]),
    )
  })
})
