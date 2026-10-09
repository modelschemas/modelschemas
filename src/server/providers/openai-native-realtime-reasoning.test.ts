import { expect, it } from 'vitest'
import docs from './fixtures/openai-native-realtime-reasoning.json'
import { parseModelPage, parseReasoningEffort } from './openai-model-docs.ts'

it('retains native realtime effort mode while published model-specific levels remain unknown', () => {
  for (const page of Object.values(docs)) {
    expect(parseModelPage(page)?.facts.reasoning).toEqual({
      mode: 'effort',
      mandatory: null,
    })
  }
})
it('ignores negative prose and fenced configurable-effort samples', () => {
  for (const sentence of [
    'Model does not support configurable reasoning effort.',
    'Model never supports configurable reasoning effort.',
    'Model supports no configurable reasoning effort.',
    'Model does not currently support configurable reasoning effort.',
    '```\nModel supports configurable reasoning effort.\n```',
  ])
    expect(parseReasoningEffort(sentence)).toBeNull()
})
