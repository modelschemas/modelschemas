import { expect, it } from 'vitest'
import docs from './fixtures/gemini-native-thinking-grammar.json'
import { parsePageThinking } from './gemini-features.ts'

it('reads native conjunction lists without inventing levels', () => {
  expect(parsePageThinking(docs['gemini-3.1-flash-lite-image'])).toEqual({
    mode: 'effort',
    mandatory: null,
    efforts: ['minimal', 'high'],
  })
})
it('keeps native interleaved reasoning controls unknown when configuration is unsupported', () => {
  expect(docs['gemini-3.8-live']).toContain('`thinking_level` is not supported')
  expect(parsePageThinking(docs['gemini-3.8-live'])).toBeNull()
})
it('rejects unknown declared levels and ignores fenced declarations', () => {
  expect(() =>
    parsePageThinking(
      docs['gemini-3.1-flash-lite-image'].replace(
        'minimal and high',
        'minimal and imaginary',
      ),
    ),
  ).toThrow()
  expect(
    parsePageThinking('```\n' + docs['gemini-3.1-flash-lite-image'] + '\n```'),
  ).toBeNull()
})
