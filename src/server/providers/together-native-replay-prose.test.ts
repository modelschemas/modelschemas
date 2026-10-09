import { expect, it } from 'vitest'
import docs from './fixtures/native-reasoning-docs.json'
import {
  parseTogetherNativeThinking,
  TOGETHER_GLM_URL,
  TOGETHER_DEEPSEEK_URL,
  TOGETHER_NATIVE_REASONING_URL,
} from './together-native-thinking.ts'

const native = docs as Record<string, string>

it('requires normative prose for Together preserved-thinking instructions', () => {
  for (const url of [TOGETHER_GLM_URL, TOGETHER_NATIVE_REASONING_URL]) {
    const text = native[url]
    if (text === undefined) throw new Error('missing native fixture: ' + url)
    expect(parseTogetherNativeThinking(text).replay.length).toBeGreaterThan(0)
    const negative = text.replace(
      /When using preserved thinking, (include the unmodified|return the model's) `reasoning_content`/g,
      'When using preserved thinking, do not $1 `reasoning_content`',
    )
    expect(parseTogetherNativeThinking(negative).replay).toEqual([])
    const fenced = text.replace(
      /When using preserved thinking, (?:include the unmodified|return the model's) `reasoning_content`[^\n]*/g,
      '```text\n$&\n```',
    )
    expect(parseTogetherNativeThinking(fenced).replay).toEqual([])
  }
})
it('requires both native DeepSeek instructions as positive prose sentences', () => {
  const text = native[TOGETHER_DEEPSEEK_URL]
  if (text === undefined) throw new Error('missing native DeepSeek fixture')
  expect(parseTogetherNativeThinking(text).replay).toEqual([
    'deepseek-ai/DeepSeek-V4-Pro-0813',
  ])
  expect(
    parseTogetherNativeThinking(
      text.replace(
        'For multi-turn function calling, pass',
        'Do not follow this instruction: For multi-turn function calling, pass',
      ),
    ).replay,
  ).toEqual([])
  expect(
    parseTogetherNativeThinking(
      text.replace(
        'Include the assistant message',
        'Do not Include the assistant message',
      ),
    ).replay,
  ).toEqual([])
  expect(
    parseTogetherNativeThinking(
      text.replace(/For multi-turn function calling[^\n]*/, '```text\n$&\n```'),
    ).replay,
  ).toEqual([])
})
