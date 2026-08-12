import { describe, expect, it } from 'vitest'

import { adapterProviders } from './load-adapters.ts'

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/

describe('adapterProviders', () => {
  it('loads unique slugged adapters with seed metadata', () => {
    const ids = adapterProviders.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const provider of adapterProviders) {
      expect(provider.id).toMatch(SLUG)
      expect(provider.specSourceUrl).toMatch(/^https:\/\//)
      expect(provider.defaultDerivation).toBeTruthy()
    }
  })
})
