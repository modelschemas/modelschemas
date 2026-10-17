import { afterEach, expect, it, vi } from 'vitest'
import { classifyOpenCodeRoute, openCodeRouteSpec } from './opencode-routes.ts'

const original = globalThis.fetch
afterEach(() => {
  globalThis.fetch = original
})
it('sources POST methods and emits only native paths, with no schema bodies', async () => {
  globalThis.fetch = vi.fn(
    async () => new Response('export function POST(input: APIEvent) {}'),
  )
  const result = await openCodeRouteSpec(
    [
      { schemaEndpointId: 'inference/v1/messages', activity: 'chat' },
      { schemaEndpointId: 'inference/v1/responses', activity: 'chat' },
      { schemaEndpointId: 'inference/v1/models/gemini', activity: 'chat' },
      { schemaEndpointId: null, activity: null },
    ],
    { url: 'https://models.dev/api.json', text: 'catalog fixture' },
    false,
  )
  expect(Object.keys(result.specs[0]?.paths ?? {})).toEqual([
    '/inference/v1/messages',
    '/inference/v1/responses',
    '/inference/v1/models/gemini',
  ])
  const operation =
    result.specs[0]?.paths?.['/inference/v1/messages']?.post ?? {}
  expect(operation).not.toHaveProperty('requestBody')
  expect(operation.responses).toEqual({})
  expect(classifyOpenCodeRoute('/inference/v1/messages', operation)).toBe(
    'chat',
  )
  expect(classifyOpenCodeRoute('/inference/v1/messages', {})).toBeNull()
  const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map(
    (call) => String(call[0]),
  )
  expect(calls.some((url) => url.endsWith('/zen/v1/models/[model].ts'))).toBe(
    true,
  )
  const source = operation['x-modelschemas-method-source'] as {
    url: string
    hash: string
  }
  expect(source.url).toContain('/zen/v1/messages.ts')
  expect(source.hash).toMatch(/^[a-f0-9]{64}$/)
})
it('sources protocol paths from the zen handlers the inference proxy maps them to', async () => {
  globalThis.fetch = vi.fn(
    async () => new Response('export function POST(input: APIEvent) {}'),
  )
  const result = await openCodeRouteSpec(
    [
      {
        schemaEndpointId: 'inference/openai/v1/chat/completions',
        activity: 'chat',
      },
      { schemaEndpointId: 'inference/openai/v1/responses', activity: 'chat' },
      { schemaEndpointId: 'inference/anthropic/v1/messages', activity: 'chat' },
      {
        schemaEndpointId: 'inference/google/v1beta/models/gemini',
        activity: 'chat',
      },
    ],
    { url: 'https://models.dev/api.json', text: 'catalog fixture' },
    false,
  )
  const paths = result.specs[0]?.paths ?? {}
  expect(
    Object.fromEntries(
      Object.entries(paths).map(([path, item]) => [
        path,
        (item.post?.['x-modelschemas-method-source'] as { url: string }).url
          .split('/routes/zen/')
          .pop(),
      ]),
    ),
  ).toEqual({
    '/inference/openai/v1/chat/completions': 'v1/chat/completions.ts',
    '/inference/openai/v1/responses': 'v1/responses.ts',
    '/inference/anthropic/v1/messages': 'v1/messages.ts',
    '/inference/google/v1beta/models/gemini': 'v1/models/[model].ts',
  })
})
it.each([
  'inference/openai/v1/messages',
  'inference/anthropic/v1/chat/completions',
  'inference/openai/v1/models/gemini',
  'inference/systemone/v1/systemone',
  'inference/go/openai/v1/chat/completions',
])('rejects %s, a path its protocol does not serve', async (id) => {
  globalThis.fetch = vi.fn(
    async () => new Response('export function POST(input: APIEvent) {}'),
  )
  await expect(
    openCodeRouteSpec(
      [{ schemaEndpointId: id, activity: 'chat' }],
      { url: 'docs', text: 'docs' },
      false,
    ),
  ).rejects.toThrow('opencode: ')
  expect(globalThis.fetch).not.toHaveBeenCalled()
})
it('rejects missing native methods rather than manufacturing an operation', async () => {
  globalThis.fetch = vi.fn(async () => new Response('export function GET() {}'))
  await expect(
    openCodeRouteSpec(
      [{ schemaEndpointId: 'v1/messages', activity: 'chat' }],
      { url: 'docs', text: 'docs' },
      false,
    ),
  ).rejects.toThrow('publishes no POST handler')
})
it('rejects a failed native source', async () => {
  globalThis.fetch = vi.fn(async () => new Response('gone', { status: 503 }))
  await expect(
    openCodeRouteSpec(
      [{ schemaEndpointId: 'v1/messages', activity: 'chat' }],
      { url: 'docs', text: 'docs' },
      true,
    ),
  ).rejects.toThrow()
})
