import { describe, expect, it } from 'vitest'

import { findDanglingRefs } from '#/server/ingest/bundle.ts'
import { classifyAndBundle } from '#/server/ingest/sync.ts'

import { REACTOR_DOCS_URL, REACTOR_PRICING_URL, provider } from './reactor.ts'

describe('reactor classify', () => {
  it('maps session + per-model command paths and drops platform', () => {
    expect(provider.classify('/sessions', {})).toBe('video')
    expect(provider.classify('/models/reactor/helios', {})).toBe('video')
    expect(provider.classify('/models/x2', {})).toBe('video')
    expect(provider.classify('/models/reactor/lingbot-world-2', {})).toBe(
      'video',
    )
    expect(provider.classify('/tokens', {})).toBeNull()
    expect(provider.classify('/pricing', {})).toBeNull()
    expect(provider.classify('/models', {})).toBeNull()
  })
})

describe('reactor listModels', () => {
  it('does not skip when REACTOR_API_KEY is absent (GET /pricing is public)', async () => {
    const original = globalThis.fetch
    globalThis.fetch = ((url: string) => {
      expect(String(url)).toBe(REACTOR_PRICING_URL)
      return Promise.resolve(
        new Response(
          JSON.stringify({
            models: [
              {
                id: 'helios-id',
                name: 'helios',
                rate: { amount_per_sec: 17, unit: 'credits' },
              },
              { name: 'x2', rate: { amount_per_sec: 17, unit: 'credits' } },
              { name: 'happy-oyster' },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
    }) as typeof fetch
    try {
      const result = await provider.listModels({})
      expect(result.skipped).toBeUndefined()
      const ids = result.models.map((m) => m.rawId)
      expect(ids).toContain('reactor/helios')
      expect(ids).toContain('x2')
      expect(ids).not.toContain('reactor/happy-oyster')
      expect(ids).toContain('reactor/happy-oyster-adventure')
      expect(new Set(ids).size).toBe(ids.length)
      expect(result.models.every((m) => m.activity === 'video')).toBe(true)
      expect(
        result.models.find((m) => m.rawId === 'reactor/helios')?.pricing,
      ).toEqual({ amount_per_sec: 17, unit: 'credits' })
    } finally {
      globalThis.fetch = original
    }
  })

  it('falls back to the docs-derived catalog when /pricing fails', async () => {
    const original = globalThis.fetch
    globalThis.fetch = () =>
      Promise.resolve(new Response('nope', { status: 500 }))
    try {
      const result = await provider.listModels({})
      expect(result.skipped).toBeUndefined()
      expect(result.models.length).toBeGreaterThan(0)
      expect(result.models.map((m) => m.rawId)).toEqual(
        expect.arrayContaining([
          'reactor/helios',
          'reactor/fast-h3',
          'x2',
          'reactor/happy-oyster-director',
        ]),
      )
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('reactor fetchSpec', () => {
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
      expect(fetched.sources[0]?.url).toBe(REACTOR_DOCS_URL)
      expect(fetched.sources[0]?.hash).toMatch(/^[0-9a-f]{64}$/)

      const { endpoints, warnings } = classifyAndBundle(provider, fetched)
      expect(warnings).toEqual([])
      const byId = new Map(endpoints.map((e) => [e.dbId, e]))
      expect(byId.get('reactor/sessions')?.activity).toBe('video')
      expect(byId.get('reactor/models/reactor/helios')?.activity).toBe('video')
      expect(byId.get('reactor/models/x2')?.activity).toBe('video')
      expect(byId.has('reactor/tokens')).toBe(false)
      expect(endpoints.length).toBeGreaterThanOrEqual(12)
      expect(endpoints.every((e) => e.activity === 'video')).toBe(true)
      expect(endpoints.every((e) => e.derivation === 'docs-derived')).toBe(true)

      for (const endpoint of endpoints) {
        expect(endpoint.input, endpoint.dbId).toBeDefined()
        expect(endpoint.output, endpoint.dbId).toBeDefined()
        if (endpoint.input) expect(findDanglingRefs(endpoint.input)).toEqual([])
        if (endpoint.output) {
          expect(findDanglingRefs(endpoint.output)).toEqual([])
        }
      }

      const helios = byId.get('reactor/models/reactor/helios')
      const oneOf = helios?.input?.oneOf
      expect(Array.isArray(oneOf)).toBe(true)
      const commands = (
        oneOf as Array<{ properties?: { command?: { const?: string } } }>
      ).map((entry) => entry.properties?.command?.const)
      expect(commands).toEqual(
        expect.arrayContaining([
          'set_prompt',
          'set_conditioning',
          'start',
          'save_snapshot',
        ]),
      )
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

describe('reactor seed metadata', () => {
  it('exports the isolation-required fields', () => {
    expect(provider.id).toBe('reactor')
    expect(provider.displayName).toBe('Reactor')
    expect(provider.authEnvVar).toBe('REACTOR_API_KEY')
    expect(provider.defaultDerivation).toBe('docs-derived')
    expect(provider.specGrain).toBe('provider')
    expect(provider.specSourceUrl).toMatch(/^https:\/\//)
    expect(provider.modelsEndpoint).toBe(REACTOR_PRICING_URL)
    expect(
      provider.generationEndpointId?.({
        rawId: 'reactor/helios',
        activity: 'video',
      }),
    ).toBe('models/reactor/helios')
    expect(
      provider.generationEndpointId?.({ rawId: 'x2', activity: 'video' }),
    ).toBe('models/x2')
  })
})
