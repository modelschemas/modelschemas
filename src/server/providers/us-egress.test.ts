import { describe, expect, it, vi } from 'vitest'

import type { ProviderEnvironment } from './types.ts'
import { usEgressFetch } from './us-egress.ts'

describe('usEgressFetch', () => {
  it('routes through the enam-hinted egress object', async () => {
    const calls: Array<unknown> = []
    const ns = {
      idFromName(name: string) {
        calls.push(['idFromName', name])
        return 'id'
      },
      get(id: string, opts: unknown) {
        calls.push(['get', id, opts])
        return {
          fetch(url: string, init?: RequestInit) {
            calls.push(['fetch', url, init?.headers])
            return Promise.resolve(Response.json({ ok: true }))
          },
        }
      },
    }
    const env = { US_EGRESS: ns } as unknown as ProviderEnvironment
    const res = await usEgressFetch(env)('https://api.example/v1/models', {
      headers: { 'x-api-key': 'k' },
    })
    expect(await res.json()).toEqual({ ok: true })
    expect(calls).toEqual([
      ['idFromName', 'provider-egress'],
      ['get', 'id', { locationHint: 'enam' }],
      ['fetch', 'https://api.example/v1/models', { 'x-api-key': 'k' }],
    ])
  })

  it('uses the global fetch outside the Workers runtime', () => {
    expect(usEgressFetch({})).toBe(fetch)
  })

  it('throws inside the Workers runtime when the binding is missing', () => {
    vi.stubGlobal('navigator', { userAgent: 'Cloudflare-Workers' })
    try {
      expect(() => usEgressFetch({})).toThrow(/US_EGRESS binding missing/)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
