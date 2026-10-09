import { expect, it } from 'vitest'
import docs from './fixtures/host-native-reasoning.json'
import {
  nativeReasoningCapability,
  parseFireworksNativeReasoning,
  parseHfHostedReasoning,
} from './native-host-reasoning.ts'

it('extracts exact hosted model links only from native explicit reasoning recommendations', () => {
  expect(parseHfHostedReasoning(docs.hf)).toEqual([
    'Qwen/Qwen3-4B-Thinking-2507',
    'deepseek-ai/DeepSeek-R1',
    'zai-org/GLM-4.5V',
  ])
  expect(() =>
    parseHfHostedReasoning('<li>reasoning capabilities</li>'),
  ).toThrow()
  expect(() =>
    parseHfHostedReasoning(
      docs.hf.replaceAll('https://huggingface.co/', 'https://example.com/'),
    ),
  ).toThrow()
})
it('reads positive native Fireworks metadata without inferring undocumented controls', () => {
  for (const [id, body] of Object.entries(docs.fireworks)) {
    expect(
      parseFireworksNativeReasoning(body, 'accounts/fireworks/models/' + id),
    ).toBe(!id.startsWith('glm'))
  }
  expect(
    parseFireworksNativeReasoning(
      { name: 'm', description: 'Does not provide reasoning capabilities.' },
      'm',
    ),
  ).toBe(false)
  for (const description of [
    'Lacks reasoning capabilities.',
    'Does not support reasoning. Reasoning capabilities are available only on another model.',
  ])
    expect(parseFireworksNativeReasoning({ name: 'm', description }, 'm')).toBe(
      false,
    )
  expect(() =>
    parseFireworksNativeReasoning(
      { name: 'other', description: 'reasoning capabilities' },
      'm',
    ),
  ).toThrow()
  expect(() => parseFireworksNativeReasoning({ name: 'm' }, 'm')).toThrow()
})
it('preserves populated flags, unknown controls, and unrelated provenance', () => {
  const source = {
    derivation: 'listing' as const,
    sourceUrl: 'https://api.fireworks.ai/v1/accounts/fireworks/models/m',
    path: 'description',
  }
  const model = {
    rawId: 'm',
    capabilities: { tools: true, structured: false },
    reasoning: null,
    factSources: { capabilities: { tools: source } },
  }
  const next = nativeReasoningCapability(model, source)
  expect(next.capabilities).toEqual({
    tools: true,
    structured: false,
    reasoning: true,
  })
  expect(next.reasoning).toBeNull()
  expect(next.factSources?.capabilities?.tools).toEqual(source)
  expect(() =>
    nativeReasoningCapability(
      { ...model, capabilities: { reasoning: false } },
      source,
    ),
  ).toThrow()
  expect(() =>
    nativeReasoningCapability(
      { ...model, unsupportedCapabilities: ['reasoning'] },
      source,
    ),
  ).toThrow()
})
