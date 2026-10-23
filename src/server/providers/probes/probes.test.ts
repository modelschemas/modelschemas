import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { bumpVerifiedAt, observationMatches } from './compare.ts'
import { probeFactSource, probedRoute, staleProbeCount } from './index.ts'
import { probeIsStale } from './types.ts'

describe('probe records', () => {
  it('binds only the exact probed model to generateContent', () => {
    expect(probedRoute('opencode-go', 'gemini-4-argon-contributor')).toBe(
      'inference/go/google/v1beta/models/gemini-4-argon-contributor:generateContent',
    )
    expect(probedRoute('opencode-go', 'gemini')).toBeNull()
    expect(probedRoute('opencode-go', 'gemini-4-argon')).toBeNull()
    expect(
      probeFactSource(
        'opencode-go',
        'gemini-4-argon-contributor',
        'inference/go/google/v1beta/models/gemini-4-argon-contributor:generateContent',
      ),
    ).toEqual({
      derivation: 'probe-verified',
      verifiedAt: '2026-10-23',
      sourceUrl:
        'src/server/providers/probes/opencode-go.ts#gemini-4-argon-contributor-generate',
    })
  })

  it('counts a record only after 90 days', () => {
    expect(
      probeIsStale('2026-10-23', new Date('2027-01-21T00:00:00.000Z')),
    ).toBe(false)
    expect(
      probeIsStale('2026-10-23', new Date('2027-01-22T00:00:00.000Z')),
    ).toBe(true)
    expect(
      staleProbeCount('opencode-go', new Date('2026-10-23T12:00:00.000Z')),
    ).toBe(0)
    expect(
      staleProbeCount('opencode-go', new Date('2027-01-22T00:00:00.000Z')),
    ).toBe(2)
  })

  it('bumps one record date and reports a mismatched body', () => {
    const source = readFileSync(
      new URL('./opencode-go.ts', import.meta.url),
      'utf8',
    )
    const next = bumpVerifiedAt(
      source,
      'gemini-4-argon-contributor-stream',
      '2026-11-01',
    )
    expect(next).toContain("verifiedAt: '2026-11-01'")
    expect(next).toContain("verifiedAt: '2026-10-23'")
    expect(
      observationMatches(
        { status: 200, jsonKeys: ['candidates'] },
        { status: 200, payloads: [{ candidates: [] }] },
      ),
    ).toBeNull()
    expect(
      observationMatches(
        { status: 200, jsonKeys: ['candidates'], sse: true },
        { status: 400, payloads: [] },
      ),
    ).toBe('status 400, expected 200')
  })
})
