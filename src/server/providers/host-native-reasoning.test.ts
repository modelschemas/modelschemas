import { afterEach, expect, it, vi } from 'vitest'
import docs from './fixtures/host-native-reasoning.json'
import { docsRun } from './model-facts.ts'
import type { ModelInfo } from './types.ts'
import {
  fireworksHostedReasoning,
  nativeReasoningCapability,
  parseFireworksNativeReasoning,
  parseHfHostedReasoning,
} from './native-host-reasoning.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

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
it('keeps a row whose Fireworks metadata is forbidden and reports the failure', async () => {
  const forbidden = 'accounts/fireworks/models/minimax-m3p1-flash'
  const open = 'accounts/fireworks/models/minimax-m3'
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      Promise.resolve(
        url.endsWith(forbidden)
          ? new Response('{ "code": 7, "details": [], "message": "" }', {
              status: 403,
              statusText: 'Forbidden',
            })
          : new Response(
              JSON.stringify({
                name: open,
                description: 'A model with strong reasoning capabilities.',
              }),
            ),
      ),
    ),
  )
  const row = (rawId: string): ModelInfo => ({
    rawId,
    activity: 'chat',
    capabilities: ['tools'],
    reasoning: null,
  })
  const run = docsRun()
  const kept = await fireworksHostedReasoning(row(forbidden), 'key', run)
  expect(kept.absent).toEqual({ capabilities: 'unavailable' })
  expect(kept.capabilities).toEqual(['tools'])
  expect(run.failed).toBe(1)
  expect(run.first[0]?.source).toBe('https://api.fireworks.ai/v1/' + forbidden)
  const read = await fireworksHostedReasoning(row(open), 'key', run)
  expect(read.capabilities).toEqual(['tools', 'reasoning'])
  expect(read.absent).toBeUndefined()
})
