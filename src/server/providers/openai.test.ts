import { expect, it } from 'vitest'
import {
  OPENAI_GPT51_GUIDE_URL,
  OPENAI_GPT52_GUIDE_URL,
  OPENAI_GPT5_GUIDE_URL,
} from './openai-gpt5-guides.ts'
import {
  OPENAI_MODELS_INDEX_URL,
  OPENAI_PRICING_URL,
} from './openai-model-docs.ts'
import { OPENAI_REALTIME_EFFORT_URL } from './openai-realtime-efforts.ts'
import { openaiProvider } from './openai.ts'

it('loads the docs through the US egress (#505)', async () => {
  const original = globalThis.fetch
  // The listing itself stays on the global fetch; a docs load there fails.
  globalThis.fetch = ((url: string) =>
    String(url).includes('developers.openai.com')
      ? Promise.reject(new Error(`global fetch called for ${String(url)}`))
      : Promise.resolve(
          Response.json({
            data: [{ id: 'gpt-5-mini' }, { id: 'gpt-realtime-2' }],
          }),
        )) as typeof fetch
  const egressed: Array<string> = []
  const ns = {
    idFromName: () => 'id',
    get: () => ({
      fetch(url: string) {
        egressed.push(String(url))
        if (url === OPENAI_MODELS_INDEX_URL)
          return Promise.resolve(
            new Response('- [GPT-5 mini](/api/docs/models/gpt-5-mini.md)'),
          )
        return Promise.resolve(new Response('# Docs'))
      },
    }),
  }
  try {
    const result = await openaiProvider.listModels({
      OPENAI_API_KEY: 'test-key',
      US_EGRESS: ns as unknown as DurableObjectNamespace,
    })
    for (const failure of result.docsFailures?.first ?? []) {
      expect(failure.error).not.toMatch(/global fetch called/)
    }
    expect(egressed).toEqual(
      expect.arrayContaining([
        OPENAI_MODELS_INDEX_URL,
        OPENAI_PRICING_URL,
        'https://developers.openai.com/api/docs/models/gpt-5-mini.md',
        OPENAI_REALTIME_EFFORT_URL,
        OPENAI_GPT5_GUIDE_URL,
        OPENAI_GPT51_GUIDE_URL,
        OPENAI_GPT52_GUIDE_URL,
      ]),
    )
  } finally {
    globalThis.fetch = original
  }
})
