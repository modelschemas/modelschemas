import { afterEach, describe, expect, it } from 'vitest'
import { fetchText } from './types.ts'
import {
  cachedGoogleDocs,
  googleDocsFailures,
  resetGoogleDocsLimit,
} from './google-docs.ts'
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
    const failures = googleDocsFailures()
    expect(failures).toMatchObject({ failed: 1, skipped: 1 })
    expect(failures.first.map((item) => item.source)).toEqual([PAGE_A])
    expect(failures.failed - failures.first.length).toBeGreaterThanOrEqual(0)
  })

  it('counts cooling skips without putting them in the failure list', async () => {
    const { kv, dropFresh } = memoryKv()
    const pages = Array.from({ length: 7 }, (_, index) => `${PAGE_A}/${index}`)
    globalThis.fetch = ((url: string) =>
      Promise.resolve(ok(String(url)))) as typeof fetch
    for (const page of pages) {
      await cachedGoogleDocs(kv, page, () => fetchText(page))
    }
    dropFresh()
    resetGoogleDocsLimit()

    globalThis.fetch = () => Promise.resolve(limited())
    for (const page of pages) {
      await cachedGoogleDocs(kv, page, () => fetchText(page))
    }
    const failures = googleDocsFailures()
    expect(failures.failed).toBe(1)
    expect(failures.skipped).toBe(6)
    expect(failures.first).toHaveLength(1)
    expect(failures.first[0]?.source).toBe(pages[0])
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
    expect(googleDocsFailures()).toEqual({ failed: 0, skipped: 0, first: [] })
  })

  it('does not store an assembly built from a stale page as a fresh hit', async () => {
    const { kv, dropFresh } = memoryKv()
    globalThis.fetch = () => Promise.resolve(ok('page'))
    await cachedGoogleDocs(kv, PAGE_B, () => fetchText(PAGE_B))
    await cachedGoogleDocs(kv, PAGE_A, async () => {
      const inner = await cachedGoogleDocs(kv, PAGE_B, () => fetchText(PAGE_B))
      return `bundle:${inner}`
    })
    dropFresh()

    let calls = 0
    globalThis.fetch = () => {
      calls += 1
      return Promise.resolve(limited())
    }
    await expect(
      cachedGoogleDocs(kv, PAGE_A, async () => {
        const inner = await cachedGoogleDocs(kv, PAGE_B, () =>
          fetchText(PAGE_B),
        )
        return `bundle:${inner}`
      }),
    ).resolves.toBe('bundle:page')
    expect(calls).toBe(1)
    expect(googleDocsFailures()).toMatchObject({
      failed: 1,
      skipped: 0,
      first: [{ source: PAGE_B }],
    })

    resetGoogleDocsLimit()
    calls = 0
    globalThis.fetch = ((url: string) => {
      calls += 1
      return Promise.resolve(ok(String(url) === PAGE_B ? 'page' : 'index'))
    }) as typeof fetch
    await cachedGoogleDocs(kv, PAGE_A, async () => {
      const inner = await cachedGoogleDocs(kv, PAGE_B, () => fetchText(PAGE_B))
      return `bundle:${inner}`
    })
    expect(calls).toBeGreaterThan(0)
    expect(googleDocsFailures()).toEqual({ failed: 0, skipped: 0, first: [] })
  })
})
