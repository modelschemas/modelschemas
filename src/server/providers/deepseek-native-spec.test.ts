import { afterEach, expect, it, vi } from 'vitest'

import {
  DEEPSEEK_CHAT_DOCS,
  decodeDeepseekOperation,
  discoverDeepseekChunk,
  fetchNativeDeepseekSpec,
  nativeDeepseekDocument,
  ownedDeepseekAsset,
} from './deepseek-native-spec.ts'

const original = globalThis.fetch
afterEach(() => {
  globalThis.fetch = original
})
const payload = {
  servers: [{ url: 'https://api.deepseek.com' }],
  method: 'post',
  path: '/chat/completions',
  info: { title: 'Native test operation' },
  requestBody: {
    required: true,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          properties: {
            messages: {
              type: 'array',
              items: {
                oneOf: [
                  {
                    type: 'object',
                    title: 'System message',
                    required: ['role', 'content'],
                  },
                ],
              },
            },
          },
        },
      },
    },
  },
  responses: {
    '200': {
      content: {
        'application/json': {
          schema: { type: 'object', required: ['choices'] },
        },
      },
    },
  },
}
const main =
  'abc:[()=>Promise.all([n.e(1)]).then(n.bind(n,2)),"@site/docs/api/create-chat-completion.api.mdx",2]'
const runtime = 'names={1:"abc"};hashes={1:"deadbeef"}'
async function chunkOf(value: unknown) {
  const compressed = await new Response(
    new Blob([JSON.stringify(value)])
      .stream()
      .pipeThrough(new CompressionStream('deflate')),
  ).arrayBuffer()
  const encoded = btoa(String.fromCharCode(...new Uint8Array(compressed)))
  return `const y={api:"${encoded}"}`
}
it('discovers only owned native assets without evaluating JavaScript', () => {
  expect(discoverDeepseekChunk(main, runtime)).toBe(
    'https://api-docs.deepseek.com/assets/js/abc.deadbeef.js',
  )
  expect(() =>
    ownedDeepseekAsset('https://elsewhere.test/assets/js/main.js'),
  ).toThrow('not owned')
  expect(() => ownedDeepseekAsset('/assets/js/main.js?redirect=1')).toThrow(
    'not owned',
  )
  expect(() => discoverDeepseekChunk('changed', runtime)).toThrow(
    'module not found',
  )
  expect(() => discoverDeepseekChunk(main, 'changed')).toThrow(
    'mapping not found',
  )
})
it('preserves incomplete native schema fragments without filling missing fields', async () => {
  const decoded = await decodeDeepseekOperation(await chunkOf(payload))
  const document = nativeDeepseekDocument(decoded)
  const operation = document.paths?.['/chat/completions']?.post
  expect(operation?.requestBody).toEqual(payload.requestBody)
  expect(operation?.responses).toEqual(payload.responses)
  expect(operation).not.toHaveProperty('path')
  expect(JSON.stringify(operation?.requestBody)).not.toContain('"enum"')
})
it('accepts duplicate identical embedded metadata but rejects conflicting native payloads', async () => {
  const chunk = await chunkOf(payload)
  expect(await decodeDeepseekOperation(chunk + chunk)).toEqual(payload)
  await expect(
    decodeDeepseekOperation(
      chunk + (await chunkOf({ ...payload, method: 'get' })),
    ),
  ).rejects.toThrow('not found uniquely')
})
it('normalizes the native documented non-streaming status without substituting streaming schemas', () => {
  const nonStreaming = payload.responses['200']
  const document = nativeDeepseekDocument({
    ...payload,
    responses: {
      '200 (No streaming)': nonStreaming,
      '200 (Streaming)': {
        content: { 'text/event-stream': { schema: { type: 'string' } } },
      },
    },
  })
  expect(document.paths?.['/chat/completions']?.post?.responses).toEqual({
    '200': nonStreaming,
  })
  expect(() =>
    nativeDeepseekDocument({
      ...payload,
      responses: { success: nonStreaming },
    }),
  ).toThrow('unreadable native response status')
})
it('fetches only owned docs assets and records the actual chunk hash', async () => {
  const chunk = await chunkOf(payload)
  const pages: Record<string, string> = {
    [DEEPSEEK_CHAT_DOCS]:
      '<script src="/assets/js/runtime~main.hash.js"></script><script src="/assets/js/main.hash.js"></script>',
    'https://api-docs.deepseek.com/assets/js/runtime~main.hash.js': runtime,
    'https://api-docs.deepseek.com/assets/js/main.hash.js': main,
    'https://api-docs.deepseek.com/assets/js/abc.deadbeef.js': chunk,
  }
  const urls: Array<string> = []
  globalThis.fetch = vi.fn(async (input) => {
    const url = String(input)
    urls.push(url)
    const body = pages[url]
    if (body === undefined) throw new Error(`unexpected ${url}`)
    return new Response(body)
  })
  const result = await fetchNativeDeepseekSpec()
  expect(urls).toHaveLength(4)
  expect(
    urls.every(
      (url) => new URL(url).origin === 'https://api-docs.deepseek.com',
    ),
  ).toBe(true)
  expect(result.sources[0]?.url).toBe(
    'https://api-docs.deepseek.com/assets/js/abc.deadbeef.js',
  )
  expect(result.sources[0]?.hash).toMatch(/^[a-f0-9]{64}$/)
  expect(result.specs[0]?.servers).toEqual(payload.servers)
})
it('fails on unavailable or malformed native evidence', async () => {
  globalThis.fetch = vi.fn(
    async () => new Response('unavailable', { status: 503 }),
  )
  await expect(fetchNativeDeepseekSpec()).rejects.toThrow('503')
  await expect(decodeDeepseekOperation('api:"broken"')).rejects.toThrow()
  expect(() =>
    nativeDeepseekDocument({
      ...payload,
      servers: [{ url: 'https://elsewhere.test' }],
    }),
  ).toThrow('not owned')
  expect(() =>
    nativeDeepseekDocument({ ...payload, path: '/made-up' }),
  ).toThrow('contract changed')
})
