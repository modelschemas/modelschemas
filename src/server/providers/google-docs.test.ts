import { afterEach, describe, expect, it } from 'vitest'
import { fetchText } from './types.ts'
import { cachedGoogleDocs, resetGoogleDocsLimit } from './google-docs.ts'
import { docsCacheKey } from './model-facts.ts'

const PAGE_A =
  'https://docs.cloud.google.com/gemini-enterprise-agent-platform/a'
const PAGE_B =
  'https://docs.cloud.google.com/gemini-enterprise-agent-platform/b'
const originalFetch = globalThis.fetch

function memoryKv(): {
  kv: KVNamespace
  dropFresh: () => void
} {
  const store = new Map<string, string>()
  const kv = {
    get: (key: string) => Promise.resolve(store.get(key) ?? null),
    put: (key: string, value: string) => {
      store.set(key, value)
      return Promise.resolve()
    },
  } as KVNamespace
  const dropFresh = (): void => {
    for (const key of store.keys()) {
      if (key.startsWith('docs:') && !key.startsWith('docs-stale:')) {
        store.delete(key)
      }
    }
  }
  return { kv, dropFresh }
}

function ok(body: string): Response {
  return new Response(body, { status: 200 })
}

function limited(): Response {
  return new Response('slow down', {
    status: 429,
    statusText: 'Too Many Requests',
  })
}

afterEach(() => {
  globalThis.fetch = originalFetch
  resetGoogleDocsLimit()
})

describe('cachedGoogleDocs', () => {
  it('serves the stored page after a 429 and does not fetch the next page', async () => {
    const { kv, dropFresh } = memoryKv()
    const pages: Record<string, string> = {
      [PAGE_A]: 'alpha',
      [PAGE_B]: 'beta',
    }
    globalThis.fetch = ((url: string) =>
      Promise.resolve(ok(pages[String(url)] ?? ''))) as typeof fetch

    await cachedGoogleDocs(kv, PAGE_A, () => fetchText(PAGE_A))
    await cachedGoogleDocs(kv, PAGE_B, () => fetchText(PAGE_B))
    dropFresh()

    const calls: Array<string> = []
    globalThis.fetch = ((url: string) => {
      calls.push(String(url))
      return Promise.resolve(limited())
    }) as typeof fetch

    await expect(
      cachedGoogleDocs(kv, PAGE_A, () => fetchText(PAGE_A)),
    ).resolves.toBe('alpha')
    await expect(
      cachedGoogleDocs(kv, PAGE_B, () => fetchText(PAGE_B)),
    ).resolves.toBe('beta')
    expect(calls).toEqual([PAGE_A])
  })

  it('fails the load when a 429 has nothing stored', async () => {
    globalThis.fetch = () => Promise.resolve(limited())
    await expect(
      cachedGoogleDocs(undefined, PAGE_A, () => fetchText(PAGE_A)),
    ).rejects.toThrow('→ 429')
  })

  it('does not serve a stored page when the status is not 429', async () => {
    const { kv, dropFresh } = memoryKv()
    globalThis.fetch = () => Promise.resolve(ok('alpha'))
    await cachedGoogleDocs(kv, PAGE_A, () => fetchText(PAGE_A))
    dropFresh()
    globalThis.fetch = () =>
      Promise.resolve(new Response('down', { status: 503 }))
    await expect(
      cachedGoogleDocs(kv, PAGE_A, () => fetchText(PAGE_A)),
    ).rejects.toThrow('503')
  })

  it('reads a fresh page from the same key as cachedDocs and does not fetch again', async () => {
    const { kv } = memoryKv()
    let calls = 0
    globalThis.fetch = () => {
      calls += 1
      return Promise.resolve(ok('alpha'))
    }
    await cachedGoogleDocs(kv, PAGE_A, () => fetchText(PAGE_A))
    await cachedGoogleDocs(kv, PAGE_A, () => fetchText(PAGE_A))
    expect(calls).toBe(1)
    expect(docsCacheKey(PAGE_A)).toMatch(/^docs:v\d+:/)
  })
})
