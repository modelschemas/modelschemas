import { afterEach, expect, it } from 'vitest'
import docs from './fixtures/openai-native-realtime-efforts.json'
import {
  parseOpenAiRealtimeEfforts,
  openaiRealtimeEfforts,
} from './openai-realtime-efforts.ts'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})
it('reads exact hosted model and normative effort table, without disable inference', () => {
  expect(parseOpenAiRealtimeEfforts(docs.markdown)).toEqual({
    rawId: 'gpt-realtime-2',
    efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],
  })
  expect(() =>
    parseOpenAiRealtimeEfforts('```\n' + docs.markdown + '\n```'),
  ).toThrow()
  expect(() =>
    parseOpenAiRealtimeEfforts(
      docs.markdown.replace(
        '`gpt-realtime-2` can trade',
        'Do not assume `gpt-realtime-2` can trade',
      ),
    ),
  ).toThrow()
  expect(() =>
    parseOpenAiRealtimeEfforts(
      docs.markdown.replace('| `minimal`', '| unsupported'),
    ),
  ).toThrow()
})
it('binds only the guide exact model even when caller selects its successor', async () => {
  globalThis.fetch = async () => new Response(docs.markdown)
  expect((await openaiRealtimeEfforts(['gpt-realtime-2.1']))?.rawId).toBe(
    'gpt-realtime-2',
  )
})
it('fails on unavailable own guide', async () => {
  globalThis.fetch = async () => new Response('unavailable', { status: 503 })
  await expect(openaiRealtimeEfforts(['gpt-realtime-2'])).rejects.toThrow('503')
})
