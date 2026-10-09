import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  VERTEX_CLAUDE_URL,
  VERTEX_CLAUDE_REQUEST_URL,
} from '../vertex-claude.ts'
import { VERTEX_PRICING_URL } from '../vertex-pricing.ts'

import { SKIP_REASON, provider } from './google-vertex-anthropic.ts'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

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
      [VERTEX_PRICING_URL]: fixture('global-pricing'),
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
    expect(listed.models).toHaveLength(1)
    expect(listed.models[0]).toMatchObject({
      rawId: 'claude-sonnet-4-6',
      contextWindow: 1_000_000,
      schemaEndpointId: null,
      serverTools: null,
    })
    expect(listed.models[0]?.pricing).not.toBeNull()
    expect(spec.skipped).toBe(SKIP_REASON)
    expect(spec.specs).toEqual([])
    expect(spec.sources[0]?.url).toBe(VERTEX_CLAUDE_REQUEST_URL)
    expect(spec.sources[0]?.hash).toMatch(/^[a-f0-9]{64}$/)
    expect(urls).toEqual(Object.keys(pages))
    expect(provider.modelsEndpoint).toBe(VERTEX_CLAUDE_URL)
  })
  it('fails a source outage rather than returning an empty successful catalog', async () => {
    globalThis.fetch = () =>
      Promise.resolve(new Response('unavailable', { status: 503 }))
    await expect(provider.listModels({})).rejects.toThrow('503')
    await expect(provider.fetchSpec({})).rejects.toThrow('503')
  })
})
