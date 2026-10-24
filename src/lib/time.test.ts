import { describe, expect, it } from 'vitest'

import { timeAgo } from './time.ts'

describe('timeAgo', () => {
  it('formats deltas into human buckets', () => {
    const now = Math.floor(Date.now() / 1000)
    expect(timeAgo(null, now)).toBe('never')
    expect(timeAgo(now - 30, now)).toBe('30s ago')
    expect(timeAgo(now - 600, now)).toBe('10m ago')
    expect(timeAgo(now - 7200, now)).toBe('2h ago')
    expect(timeAgo(now - 259_200, now)).toBe('3d ago')
  })

  it('measures from the given instant, not the clock, so SSR and hydration agree', () => {
    // A server render and the later hydration pass the same `now`.
    const renderedAt = 1_700_000_000
    expect(timeAgo(renderedAt - 45, renderedAt)).toBe('45s ago')
  })
})
