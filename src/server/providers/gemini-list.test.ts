import { afterEach, describe, expect, it, vi } from 'vitest'

import { geminiProvider } from './gemini.ts'

const KEY = 'test-gemini-key-123'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('gemini listModels', () => {
  it('sends the key as a header so a failed fetch never quotes it', async () => {
    const seen: Array<{ url: string; key: string | null }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string, init?: RequestInit) => {
        if (
          !input.startsWith(
            'https://generativelanguage.googleapis.com/v1beta/models?',
          )
        ) {
          // Docs loads run alongside the listing; leave them pending.
          return new Promise<Response>(() => {})
        }
        seen.push({
          url: input,
          key: new Headers(init?.headers).get('x-goog-api-key'),
        })
        return Promise.resolve(
          new Response('bad', { status: 400, statusText: 'Bad Request' }),
        )
      }),
    )

    const error = await geminiProvider.listModels({ GEMINI_API_KEY: KEY }).then(
      () => null,
      (err: unknown) => err,
    )

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('400 Bad Request')
    expect((error as Error).message).not.toContain(KEY)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.url).not.toContain(KEY)
    expect(seen[0]?.key).toBe(KEY)
  })
})
