import { describe, expect, it } from 'vitest'
import glmNative from './fixtures/zai-native-thinking-replay.json'
import {
  applyReplay,
  deepseekEffortFacts,
  explicitCardReplay,
  parseDeepseekReplay,
  parseGlmReplay,
  parseKimiReplay,
  loadReplayDoc,
} from './provider-replay.ts'

import {
  GLM_REPLAY_FIXTURE,
  KIMI_REPLAY_FIXTURE,
  DEEPSEEK_REPLAY_FIXTURE,
} from './fixtures/provider-replay.ts'

describe('provider-owned reasoning and replay evidence', () => {
  it('includes the exact GLM-4.5 model named by the native interleaved tool-turn rule', () => {
    const ids = parseGlmReplay(glmNative.markdown)
    expect(ids).toContain('glm-4.5')
    expect(ids).not.toContain('glm-4.5-air')
    expect(ids).not.toContain('glm-5.3-flashx')
    const variant = parseGlmReplay(
      glmNative.markdown.replace(
        'supported since GLM-4.5',
        'supported since GLM-4.5-Air',
      ),
    )
    expect(variant).toContain('glm-4.5-air')
    expect(variant).not.toContain('glm-4.5')
  })
  it('does not infer mandatory thinking from native effort values', () => {
    expect(
      deepseekEffortFacts({ supported_levels: ['high', 'max'] })?.reasoning,
    ).toEqual({ mode: 'effort', mandatory: null, efforts: ['high', 'max'] })
    expect(
      deepseekEffortFacts({ supported_levels: ['none', 'high'] })?.reasoning
        .mandatory,
    ).toBeNull()
    expect(deepseekEffortFacts(undefined)).toBeNull()
  })
  it.each([
    {},
    'bad',
    { supported_levels: [] },
    { supported_levels: [null] },
    { supported_levels: 'high' },
  ])('does not swallow malformed effort metadata %j', (value) => {
    if (typeof value === 'object' && Object.keys(value).length === 0)
      expect(deepseekEffortFacts(value)).toBeNull()
    else expect(() => deepseekEffortFacts(value)).toThrow(/unreadable/)
  })
  it('requires the native DeepSeek conditional tool contract', () => {
    expect(parseDeepseekReplay(DEEPSEEK_REPLAY_FIXTURE)).toBe(true)
    expect(() =>
      parseDeepseekReplay('response exposes reasoning_content'),
    ).toThrow(/no verified/)
  })
  it('binds GLM replay only to explicitly named models', () => {
    expect(parseGlmReplay(GLM_REPLAY_FIXTURE)).toEqual([
      'glm-5.2',
      'glm-5.3',
      'glm-5.3-flash',
    ])
    expect(() =>
      parseGlmReplay(GLM_REPLAY_FIXTURE.replace('preserved', 'omitted')),
    ).toThrow(/no verified/)
    expect(parseGlmReplay(GLM_REPLAY_FIXTURE)).not.toContain('glm-5.3-flashx')
  })
  it('binds exact Kimi ids including the explicitly documented highspeed variant', () => {
    expect(parseKimiReplay(KIMI_REPLAY_FIXTURE)).toEqual([
      'kimi-k3',
      'kimi-k2.7-code',
      'kimi-k2.7-code-highspeed',
      'kimi-k2.6',
    ])
    expect(() => parseKimiReplay('A model returns reasoning_content.')).toThrow(
      /no verified/,
    )
  })
  it('does not mistake output-only documentation for replay evidence', () => {
    expect(explicitCardReplay('Output supports reasoning_content.')).toBe(false)
    expect(
      explicitCardReplay(
        'Clients must pass back the complete assistant message, including reasoning_content.',
      ),
    ).toBe(true)
  })
  it('preserves other sourced fields and provenance while leaving unknown wire fields null', () => {
    const source = {
      derivation: 'docs-derived' as const,
      sourceUrl: 'https://example.com/native',
      sourceHash: 'hash',
    }
    const model = applyReplay(
      {
        rawId: 'synthetic',
        activity: 'chat',
        factSources: { reasoning: { derivation: 'listing' } },
      },
      source,
    )
    expect(model.requestMap).toMatchObject({
      replayReasoningContent: true,
      thinking: null,
      maxTokensField: null,
      developerRole: null,
    })
    expect(model.factSources?.reasoning).toEqual({ derivation: 'listing' })
    expect(model.factSources?.requestMap).toEqual(source)
    expect(model.factSources?.requestMapFields?.replayReasoningContent).toEqual(
      source,
    )
    const original = {
      derivation: 'upstream-spec' as const,
      sourceUrl: 'https://example.com/spec',
    }
    const enriched = applyReplay(
      {
        ...model,
        requestMap: { ...model.requestMap!, maxTokensField: 'max_tokens' },
        factSources: { requestMap: original },
      },
      source,
    )
    expect(enriched.requestMap?.maxTokensField).toBe('max_tokens')
    expect(enriched.factSources?.requestMap).toEqual(original)
    expect(
      enriched.factSources?.requestMapFields?.replayReasoningContent,
    ).toEqual(source)
  })
})

it('reports native docs fetch failures instead of claiming unknown replay is false', async () => {
  const original = globalThis.fetch
  globalThis.fetch = () =>
    Promise.resolve(new Response('unavailable', { status: 503 }))
  try {
    await expect(loadReplayDoc('https://example.com/native')).rejects.toThrow(
      /503/,
    )
  } finally {
    globalThis.fetch = original
  }
})
