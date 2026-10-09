import { expect, it } from 'vitest'
import fixture from './fixtures/replay-extra-native.json'
import {
  zaiSpecFacts,
  parseZaiModels,
  ZAI_OPENAPI_URL,
} from './adapters/zai.ts'
import {
  parseTogetherNativeThinking,
  applyTogetherNativeThinking,
} from './together-native-thinking.ts'

const source = { url: ZAI_OPENAPI_URL, hash: 'native-source-hash' }
it('sources exact ZAI request-variant replay rules without copying sibling facts or stamping non-reasoning models', () => {
  const facts = zaiSpecFacts(fixture.spec, source)
  for (const id of [
    'glm-4.5-air',
    'glm-4.7-flashx',
    'glm-4.6v-flash',
    'glm-5.3-flashx',
  ]) {
    expect(facts.get(id)?.replayReasoningContent).toMatchObject({
      derivation: 'upstream-spec',
      sourceUrl: ZAI_OPENAPI_URL,
    })
    expect(facts.get(id)?.replayReasoningContent?.path).toContain('model=' + id)
  }
  expect(facts.has('glm-unpublished-sibling')).toBe(false)
  const models = parseZaiModels(
    { ...source, text: JSON.stringify(fixture.spec) },
    fixture.zaiDocs.pricing,
    fixture.zaiDocs.overview,
    fixture.zaiDocs.thinking,
    '2026-10-09T00:00:00Z',
  )
  expect(
    models.find((x) => x.rawId === 'glm-4.5-air')?.requestMap
      ?.replayReasoningContent,
  ).toBe(true)
  expect(
    models.find((x) => x.rawId === 'glm-5.3-flashx')?.factSources
      ?.requestMapFields?.replayReasoningContent?.sourceUrl,
  ).toBe(ZAI_OPENAPI_URL)
  expect(
    models.find((x) => x.rawId === 'glm-4-32b-0414-128k')?.requestMap,
  ).toBeUndefined()
})
it('honors explicit native ZAI property model restrictions and leaves unsupported prose unsourced', () => {
  const spec = structuredClone(fixture.spec)
  const field = spec.components.schemas.ChatThinking.properties.clear_thinking
  field.description += ' Only supported by GLM-4.7.'
  const facts = zaiSpecFacts(spec, source)
  expect(facts.get('glm-4.7')?.replayReasoningContent).toBeDefined()
  expect(facts.get('glm-4.5-air')?.replayReasoningContent).toBeUndefined()
  field.description = 'Retains some history.'
  expect(
    zaiSpecFacts(spec, source).get('glm-4.7')?.replayReasoningContent,
  ).toBeUndefined()
  field.description = 'Only supports GLM-4.7+.'
  expect(() => zaiSpecFacts(spec, source)).toThrow(
    'unreadable clear_thinking model restriction',
  )
})
it('sources Together Kimi K3 replay only from the exact native history instruction', () => {
  const parsed = parseTogetherNativeThinking(fixture.kimiMarkdown)
  expect(parsed.replay).toEqual(['moonshotai/Kimi-K3'])
  const doc = {
    ...parsed,
    url: fixture.kimiSourceUrl,
    hash: 'native-kimi-hash',
  }
  const result = applyTogetherNativeThinking(
    { rawId: 'moonshotai/Kimi-K3', activity: 'chat' },
    [doc],
  )
  expect(result.requestMap?.replayReasoningContent).toBe(true)
  expect(
    result.factSources?.requestMapFields?.replayReasoningContent?.sourceUrl,
  ).toBe(fixture.kimiSourceUrl)
  expect(result.requestMap?.maxTokensField).toBeNull()
  expect(
    applyTogetherNativeThinking(
      { rawId: 'moonshotai/Kimi-K2.7-Code', activity: 'chat' },
      [doc],
    ).requestMap,
  ).toBeUndefined()
  expect(
    parseTogetherNativeThinking(
      fixture.kimiMarkdown.replace(
        'Return the complete assistant message on every turn, `reasoning_content` included',
        'Return visible content only',
      ),
    ).replay,
  ).toEqual([])
})
