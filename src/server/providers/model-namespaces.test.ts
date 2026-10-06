import { expect, it } from 'vitest'

import { providerRegistry } from './index.ts'

// Two claimants make a namespace ambiguous, and a provider id always beats a
// namespace of the same name: either would silently drop sameAs links.
it('claims each model namespace once and never shadows a provider id', () => {
  const ids = new Set(providerRegistry.map((p) => p.id))
  const claimed = providerRegistry.flatMap((p) => p.modelNamespaces ?? [])
  expect(claimed).toEqual(expect.arrayContaining(['google', 'x-ai', 'xai']))
  expect(new Set(claimed).size).toBe(claimed.length)
  expect(claimed.filter((namespace) => ids.has(namespace))).toEqual([])
})
