import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { googleDocsFailures, resetGoogleDocsLimit } from '../google-docs.ts'
import {
  VERTEX_CLAUDE_URL,
  VERTEX_CLAUDE_REQUEST_URL,
} from '../vertex-claude.ts'

import { SKIP_REASON, provider } from './google-vertex-anthropic.ts'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  resetGoogleDocsLimit()
})

function memoryKv(): { kv: KVNamespace; dropFreshDocs: () => void } {
  const store = new Map<string, string>()
  const kv = {
    get: (key: string) => Promise.resolve(store.get(key) ?? null),
    put: (key: string, value: string) => {
      store.set(key, value)
      return Promise.resolve()
    },
  } as KVNamespace
  const dropFreshDocs = (): void => {
    for (const key of store.keys()) {
      if (
        key.startsWith('docs:') &&
        !key.startsWith('docs-stale:') &&
        key.includes('docs.cloud.google.com')
      ) {
        store.delete(key)
      }
    }
  }
  return { kv, dropFreshDocs }
}

describe('google-vertex-anthropic', () => {
  it('fetches Google cards and pricing while preserving unknown body schemas', async () => {
    const urls: Array<string> = []
    const path =
      '/gemini-enterprise-agent-platform/models/partner-models/claude/sonnet-4-6'
    const fixture = (name: string) =>
      readFileSync(
        new URL(`../fixtures/vertex-claude/${name}.html.txt`, import.meta.url),
        'utf8',
      )
    const pages: Record<string, string> = {
      [VERTEX_CLAUDE_URL]: `<article><a href="${path}">Claude Sonnet 4.6</a></article>`,
      [`https://docs.cloud.google.com${path}`]: fixture('sonnet-4-6'),
      'https://cloud.google.com/model-garden/partner-models/pricing':
        fixture('global-pricing'),
      [VERTEX_CLAUDE_REQUEST_URL]:
        'Google request examples: :rawPredict with anthropic_version',
    }
    globalThis.fetch = ((url: string) => {
      urls.push(String(url))
      const text = pages[String(url)]
      if (text === undefined)
        throw new Error(`unexpected fetch: ${String(url)}`)
      return Promise.resolve(new Response(text))
    }) as typeof fetch

    const listed = await provider.listModels({})
    const spec = await provider.fetchSpec({})

    expect(listed.skipped).toBeUndefined()
    expect(listed.docsFailures).toEqual({ failed: 0, skipped: 0, first: [] })
    expect(listed.models).toHaveLength(1)
    expect(listed.models[0]).toMatchObject({
      rawId: 'claude-sonnet-4-6',
      contextWindow: 1_000_000,
      schemaEndpointId: null,
      serverTools: null,
    })
    expect(listed.models[0]?.pricing).not.toBeNull()
    expect(listed.models[0]?.pricing).toMatchObject({
      source: {
        url: 'https://cloud.google.com/model-garden/partner-models/pricing',
      },
    })
    expect(listed.models[0]?.factSources?.pricing?.sourceUrl).toBe(
      'https://cloud.google.com/model-garden/partner-models/pricing',
    )
    expect(spec.skipped).toBe(SKIP_REASON)
    expect(spec.specs).toEqual([])
    expect(spec.sources[0]?.url).toBe(VERTEX_CLAUDE_REQUEST_URL)
    expect(spec.sources[0]?.hash).toMatch(/^[a-f0-9]{64}$/)
    expect(urls).toEqual(Object.keys(pages))
    expect(provider.modelsEndpoint).toBe(VERTEX_CLAUDE_URL)
  })
  it('keeps the last catalog when docs.cloud.google.com answers 429', async () => {
    const path =
      '/gemini-enterprise-agent-platform/models/partner-models/claude/sonnet-4-6'
    const fixture = (name: string) =>
      readFileSync(
        new URL(`../fixtures/vertex-claude/${name}.html.txt`, import.meta.url),
        'utf8',
      )
    const pages: Record<string, string> = {
      [VERTEX_CLAUDE_URL]: `<article><a href="${path}">Claude Sonnet 4.6</a></article>`,
      [`https://docs.cloud.google.com${path}`]: fixture('sonnet-4-6'),
      'https://cloud.google.com/model-garden/partner-models/pricing':
        fixture('global-pricing'),
    }
    globalThis.fetch = ((url: string) => {
      const text = pages[String(url)]
      if (text === undefined)
        throw new Error(`unexpected fetch: ${String(url)}`)
      return Promise.resolve(new Response(text))
    }) as typeof fetch
    const { kv, dropFreshDocs } = memoryKv()
    const first = await provider.listModels({}, kv)
    expect(first.models[0]?.rawId).toBe('claude-sonnet-4-6')
    dropFreshDocs()

    const calls: Array<string> = []
    globalThis.fetch = ((url: string) => {
      calls.push(String(url))
      if (String(url).includes('docs.cloud.google.com')) {
        return Promise.resolve(
          new Response('slow down', {
            status: 429,
            statusText: 'Too Many Requests',
          }),
        )
      }
      const text = pages[String(url)]
      if (text === undefined) {
        throw new Error(`unexpected fetch: ${String(url)}`)
      }
      return Promise.resolve(new Response(text))
    }) as typeof fetch
    const again = await provider.listModels({}, kv)
    expect(again.models[0]?.rawId).toBe('claude-sonnet-4-6')
    expect(
      calls.filter((url) => url.includes('docs.cloud.google.com')),
    ).toEqual([VERTEX_CLAUDE_URL])
    expect(again.docsFailures).toMatchObject({ failed: 1, skipped: 1 })
    expect(again.docsFailures?.first.map((item) => item.source)).toEqual([
      `${VERTEX_CLAUDE_URL}#paths`,
      `https://docs.cloud.google.com${path}`,
    ])

    resetGoogleDocsLimit()
    calls.length = 0
    globalThis.fetch = ((url: string) => {
      calls.push(String(url))
      const text = pages[String(url)]
      if (text === undefined) {
        throw new Error(`unexpected fetch: ${String(url)}`)
      }
      return Promise.resolve(new Response(text))
    }) as typeof fetch
    const recovered = await provider.listModels({}, kv)
    expect(
      calls.filter((url) => url.includes('docs.cloud.google.com')).length,
    ).toBeGreaterThan(0)
    expect(recovered.models[0]?.rawId).toBe('claude-sonnet-4-6')
    expect(recovered.docsFailures).toEqual({
      failed: 0,
      skipped: 0,
      first: [],
    })
    expect(googleDocsFailures()).toEqual(recovered.docsFailures)
  })
  it('fails a source outage rather than returning an empty successful catalog', async () => {
    globalThis.fetch = () =>
      Promise.resolve(new Response('unavailable', { status: 503 }))
    await expect(provider.listModels({})).rejects.toThrow('503')
    await expect(provider.fetchSpec({})).rejects.toThrow('503')
  })
})
