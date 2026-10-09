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
      { schemaEndpointId: 'v1/messages', activity: 'chat' },
      { schemaEndpointId: 'v1/responses', activity: 'chat' },
      { schemaEndpointId: null, activity: null },
    ],
    { url: 'https://opencode.ai/docs/zen.md', text: 'docs fixture' },
    false,
  )
  expect(Object.keys(result.specs[0]?.paths ?? {})).toEqual([
    '/v1/messages',
    '/v1/responses',
  ])
  const operation = result.specs[0]?.paths?.['/v1/messages']?.post ?? {}
  expect(operation).not.toHaveProperty('requestBody')
  expect(operation.responses).toEqual({})
  expect(classifyOpenCodeRoute('/v1/messages', operation)).toBe('chat')
  expect(classifyOpenCodeRoute('/v1/messages', {})).toBeNull()
  const source = operation['x-modelschemas-method-source'] as {
    url: string
    hash: string
  }
  expect(source.url).toContain('/zen/v1/messages.ts')
  expect(source.hash).toMatch(/^[a-f0-9]{64}$/)
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
