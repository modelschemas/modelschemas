import { describe, expect, it } from 'vitest'

import { findDanglingRefs } from '#/server/ingest/bundle.ts'
import { classifyAndBundle } from '#/server/ingest/sync.ts'

import { provider } from './kling.ts'

describe('kling classify', () => {
  it('maps generation create paths and drops platform/query paths', () => {
    expect(provider.classify('/v1/videos/text2video', {})).toBe('video')
    expect(provider.classify('/v1/videos/image2video', {})).toBe('video')
    expect(provider.classify('/v1/images/generations', {})).toBe('image')
    expect(provider.classify('/v1/videos/text2video/{task_id}', {})).toBeNull()
    expect(provider.classify('/v1/images/generations/{task_id}', {})).toBeNull()
    expect(provider.classify('/account/costs', {})).toBeNull()
    expect(provider.classify('/v1/videos/video-extend', {})).toBeNull()
  })
})

describe('kling listModels', () => {
  it('skips when KLING_API_KEY is absent', async () => {
    const result = await provider.listModels({})
    expect(result.skipped).toBe('kling: KLING_API_KEY not set — skipped')
    expect(result.models).toEqual([])
  })

  it('returns the docs-derived catalog when a bearer is present', async () => {
    const result = await provider.listModels({ KLING_API_KEY: 'kling-test' })
    expect(result.skipped).toBeUndefined()
    expect(result.models.length).toBeGreaterThan(0)
    expect(new Set(result.models.map((m) => m.rawId)).size).toBe(
      result.models.length,
    )
    const activities = new Set(result.models.map((m) => m.activity))
    expect(activities.has('video')).toBe(true)
    expect(activities.has('image')).toBe(true)
  })
})

describe('kling fetchSpec', () => {
  it('serves the embedded spec without touching the network', async () => {
    const original = globalThis.fetch
    const calls: Array<string> = []
    globalThis.fetch = ((url: string) => {
      calls.push(String(url))
      return Promise.reject(new Error('network should not be used'))
    }) as typeof fetch
    try {
      const fetched = await provider.fetchSpec({})
      expect(calls).toEqual([])
      expect(fetched.outputStrategy).toBe('post-200')
      expect(fetched.sources[0]?.url).toBe(
        'https://app.klingai.com/global/dev/document-api',
      )
      expect(fetched.sources[0]?.hash).toMatch(/^[0-9a-f]{64}$/)

      const { endpoints, warnings } = classifyAndBundle(provider, fetched)
      expect(warnings).toEqual([])
      expect(endpoints.map((e) => [e.dbId, e.activity]).sort()).toEqual([
        ['kling/v1/images/generations', 'image'],
        ['kling/v1/videos/image2video', 'video'],
        ['kling/v1/videos/text2video', 'video'],
      ])
      for (const endpoint of endpoints) {
        expect(endpoint.derivation).toBe('docs-derived')
        expect(endpoint.input, endpoint.dbId).toBeDefined()
        expect(endpoint.output, endpoint.dbId).toBeDefined()
        if (endpoint.input) expect(findDanglingRefs(endpoint.input)).toEqual([])
        if (endpoint.output) {
          expect(findDanglingRefs(endpoint.output)).toEqual([])
        }
      }

      const t2v = endpoints.find((e) => e.path === '/v1/videos/text2video')
      expect(t2v?.input?.required).toEqual(['prompt'])
    } finally {
      globalThis.fetch = original
    }
  })

  it('hashes the embedded document stably', async () => {
    const a = await provider.fetchSpec({})
    const b = await provider.fetchSpec({})
    expect(a.sources.map((s) => s.hash)).toEqual(b.sources.map((s) => s.hash))
  })
})

describe('kling seed metadata', () => {
  it('exports the isolation-required fields', () => {
    expect(provider.id).toBe('kling')
    expect(provider.displayName).toBe('Kling AI')
    expect(provider.authEnvVar).toBe('KLING_API_KEY')
    expect(provider.defaultDerivation).toBe('docs-derived')
    expect(provider.specSourceUrl).toMatch(/^https:\/\//)
    expect(provider.modelsEndpoint).toMatch(/^https:\/\//)
  })
})
