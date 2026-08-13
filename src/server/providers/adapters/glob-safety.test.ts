import { describe, expect, it } from 'vitest'

import { classifyAndBundle } from '#/server/ingest/sync.ts'
import { providerRegistry } from '../index.ts'
import { adapterProviders } from '../load-adapters.ts'

/**
 * Reproduces the CI failure: an adapters/*.test.ts that imports
 * classifyAndBundle → sync → registry. If the glob eager-loads this
 * file, adapterProviders is still undefined and spreading it throws.
 */
describe('adapter glob excludes tests', () => {
  it('keeps the registry iterable when a test imports classifyAndBundle', () => {
    expect(Array.isArray(adapterProviders)).toBe(true)
    expect(Array.isArray(providerRegistry)).toBe(true)
    expect(typeof classifyAndBundle).toBe('function')
  })
})
