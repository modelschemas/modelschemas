import { afterEach, expect, it } from 'vitest'
import docs from './fixtures/gemini-native-audio-thinking.json'
import {
  geminiNativeAudioThinking,
  parseGeminiNativeAudioThinking,
} from './gemini-live-thinking.ts'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})
it('sources exact native audio budget mode and disable semantics without bounds guesses', () => {
  expect(parseGeminiNativeAudioThinking(docs.markdown)).toEqual({
    rawId: 'gemini-2.5-flash-native-audio-preview-12-2025',
    reasoning: { mode: 'budget', mandatory: false },
  })
  expect(() =>
    parseGeminiNativeAudioThinking('```\n' + docs.markdown + '\n```'),
  ).toThrow()
  expect(() =>
    parseGeminiNativeAudioThinking(
      docs.markdown.replace(
        'You can disable thinking by setting',
        'You cannot disable thinking by setting',
      ),
    ),
  ).toThrow()
})
it('uses model names only to select own guide; exact binding excludes latest aliases', async () => {
  globalThis.fetch = async () => new Response(docs.markdown)
  const parsed = await geminiNativeAudioThinking([
    'gemini-2.5-flash-native-audio-latest',
  ])
  expect(parsed?.rawId).toBe('gemini-2.5-flash-native-audio-preview-12-2025')
  expect(parsed?.rawId).not.toBe('gemini-2.5-flash-native-audio-latest')
})
it('fails clearly when the native source cannot be read', async () => {
  globalThis.fetch = async () => new Response('unavailable', { status: 503 })
  await expect(
    geminiNativeAudioThinking([
      'gemini-2.5-flash-native-audio-preview-12-2025',
    ]),
  ).rejects.toThrow('503')
})

it('rejects positive instruction text embedded in negated prose', () => {
  for (const phrase of [
    'The latest native audio output model',
    'The `thinkingBudget` parameter guides',
    'You can disable thinking by setting',
  ]) {
    expect(() =>
      parseGeminiNativeAudioThinking(
        docs.markdown.replace(phrase, 'Do not assume ' + phrase),
      ),
    ).toThrow()
  }
})
