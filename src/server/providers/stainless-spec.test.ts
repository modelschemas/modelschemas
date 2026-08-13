import { describe, expect, it } from 'vitest'

import { providerSeeds } from '#/db/seed-providers.ts'

import { OPENAI_SPEC_URL } from './openai.ts'
import { stainlessSpecUrlFromStats } from './types.ts'

describe('stainlessSpecUrlFromStats', () => {
  it('reads the openapi_spec_url field', () => {
    expect(
      stainlessSpecUrlFromStats(
        [
          'configured_endpoints: 131',
          'openapi_spec_url: https://example.test/spec.yml',
          'openapi_spec_hash: abc',
        ].join('\n'),
        'anthropic',
      ),
    ).toBe('https://example.test/spec.yml')
  })

  it('throws when the field is missing', () => {
    expect(() =>
      stainlessSpecUrlFromStats('config_hash: abc\n', 'openai'),
    ).toThrow(/openai \.stats\.yml: couldn't find openapi_spec_url/)
  })
})

describe('openai spec source', () => {
  it('seeds the Castiron transformed spec, not the lagging public export', () => {
    const openai = providerSeeds.find((p) => p.id === 'openai')
    expect(openai?.specSourceUrl).toBe(OPENAI_SPEC_URL)
    expect(OPENAI_SPEC_URL).toContain('openai-node')
    expect(OPENAI_SPEC_URL).toContain('openapi.transformed.yml')
  })
})
