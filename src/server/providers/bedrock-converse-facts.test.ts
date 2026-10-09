import { afterEach, expect, it } from 'vitest'
import sdk from './fixtures/bedrock-converse-native-sdk.json'
import {
  loadBedrockConverseWireMaps,
  parseBedrockConverseWireMap,
} from './bedrock-converse-facts.ts'
import { BEDROCK_SDK_MODEL_URL } from './bedrock-sdk-spec.ts'
import type { BedrockServiceModel } from './bedrock-sdk-spec.ts'
import { docsReport, docsRun } from './model-facts.ts'
import { sha256Text } from './types.ts'
import type { ModelInfo } from './types.ts'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})
const base = (): ModelInfo => ({
  rawId: 'eu.anthropic.claude-haiku-4-5-20251001-v1:0',
  schemaEndpointId: 'model/{modelId}/converse',
  requestMap: null,
  factSources: {
    schemaEndpointId: {
      derivation: 'docs-derived',
      sourceUrl: 'https://docs.aws.amazon.com/bedrock/card.md',
      sourceHash: 'card-hash',
    },
  },
})
const mutable = () => structuredClone(sdk) as unknown as BedrockServiceModel
it('derives only published wire facts from the complete native SDK, leaving model-specific mappings unknown', () => {
  const map = parseBedrockConverseWireMap(sdk)
  expect(map.developerRole).toBe(false)
  expect(map.reasoningEffort).toBe(false)
  expect(map.thinking).toBeNull()
  expect(map.maxTokensField).toBeNull()
  expect(map.replayReasoningContent).toBeNull()
  expect(map.strictTools).toBeNull()
})
it('source changes to native role enums and closed input members change the synced flags', () => {
  const changed = mutable()
  const input = changed.shapes[changed.operations.Converse!.input!.shape]!
  const messageList = changed.shapes[input.members!.messages!.shape]!
  const message = changed.shapes[messageList.member!.shape]!
  const role = changed.shapes[message.members!.role!.shape]!
  role.enum = [...role.enum!, 'developer']
  input.members!.reasoning_effort = { shape: 'String' }
  expect(parseBedrockConverseWireMap(changed)).toMatchObject({
    developerRole: true,
    reasoningEffort: true,
  })
  input.members!.reasoning_effort.location = 'header'
  expect(parseBedrockConverseWireMap(changed).reasoningEffort).toBe(false)
})
it('refuses document inputs, missing role enums and malformed native locations instead of asserting negative facts', () => {
  const open = mutable()
  open.shapes[open.operations.Converse!.input!.shape]!.document = true
  expect(() => parseBedrockConverseWireMap(open)).toThrow(
    'closed Smithy structure',
  )
  const bad = mutable()
  const input = bad.shapes[bad.operations.Converse!.input!.shape]!
  const role =
    bad.shapes[
      bad.shapes[bad.shapes[input.members!.messages!.shape]!.member!.shape]!
        .members!.role!.shape
    ]!
  delete role.enum
  expect(() => parseBedrockConverseWireMap(bad)).toThrow('role enum')
  input.members!.reasoning_effort = { shape: 'String', location: 'unreadable' }
  expect(() => parseBedrockConverseWireMap(bad)).toThrow('Smithy member')
})
it('uses the exact fetched SDK hash for maps and keeps independently sourced endpoint ownership', async () => {
  const text = JSON.stringify(sdk)
  globalThis.fetch = () => Promise.resolve(new Response(text))
  const run = docsRun()
  const unrelated = {
    ...base(),
    rawId: 'anthropic.claude-haiku-4-5',
    schemaEndpointId: null,
  }
  const result = await loadBedrockConverseWireMaps([base(), unrelated], run)
  expect(result[0]?.requestMap?.developerRole).toBe(false)
  expect(result[0]?.factSources?.requestMap).toEqual({
    derivation: 'generated',
    sourceUrl: BEDROCK_SDK_MODEL_URL,
    sourceHash: await sha256Text(text),
    path: '#/operations/Converse/input',
  })
  expect(result[0]?.factSources?.schemaEndpointId?.sourceHash).toBe('card-hash')
  expect(result[1]).toBe(unrelated)
  expect(docsReport(run).failed).toBe(0)
})
it('reports SDK fetch and parse failures visibly, keeping maps unavailable without a static substitute', async () => {
  for (const response of [
    () => new Response('offline', { status: 503 }),
    () => new Response('malformed JSON'),
    () => new Response('{}'),
  ]) {
    globalThis.fetch = () => Promise.resolve(response())
    const run = docsRun()
    const result = await loadBedrockConverseWireMaps([base()], run)
    expect(result[0]?.requestMap).toBeNull()
    expect(result[0]?.absent?.requestMap).toBe('unavailable')
    expect(result[0]?.schemaEndpointId).toBe('model/{modelId}/converse')
    expect(docsReport(run).failed).toBe(1)
    expect(docsReport(run).first[0]?.source).toBe(BEDROCK_SDK_MODEL_URL)
  }
})
it('preserves independently sourced replay leaves and rejects a contradictory current native flag', async () => {
  globalThis.fetch = () => Promise.resolve(new Response(JSON.stringify(sdk)))
  const previous = {
    derivation: 'docs-derived' as const,
    sourceUrl: 'https://docs.aws.amazon.com/replay.md',
    sourceHash: 'replay-hash',
  }
  const model = {
    ...base(),
    requestMap: {
      ...parseBedrockConverseWireMap(sdk),
      replayReasoningContent: true,
    },
    factSources: { ...base().factSources, requestMap: previous },
  }
  const run = docsRun()
  const result = await loadBedrockConverseWireMaps([model], run)
  expect(result[0]?.requestMap?.replayReasoningContent).toBe(true)
  expect(
    result[0]?.factSources?.requestMapFields?.replayReasoningContent,
  ).toEqual(previous)
  expect(result[0]?.factSources?.requestMap?.sourceUrl).toBe(
    BEDROCK_SDK_MODEL_URL,
  )
  const conflict = {
    ...model,
    requestMap: { ...model.requestMap, developerRole: true },
  }
  const failed = docsRun()
  const guarded = await loadBedrockConverseWireMaps([conflict], failed)
  expect(docsReport(failed).failed).toBe(1)
  expect(docsReport(failed).first[0]?.error).toContain(
    'contradicts existing native developerRole',
  )
  expect(guarded[0]?.absent?.requestMap).toBe('unavailable')
})
