import { describe, expect, it } from 'vitest'

import { timeAgo } from './index.tsx'

describe('timeAgo', () => {
  it('formats deltas into human buckets', () => {
    const now = Math.floor(Date.now() / 1000)
    expect(timeAgo(null)).toBe('never')
    expect(timeAgo(now - 30)).toBe('30s ago')
    expect(timeAgo(now - 600)).toBe('10m ago')
    expect(timeAgo(now - 7200)).toBe('2h ago')
    expect(timeAgo(now - 259_200)).toBe('3d ago')
  })
})
