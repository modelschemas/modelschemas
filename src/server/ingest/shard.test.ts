import { describe, expect, it } from 'vitest'

import { providerRegistry } from '#/server/providers/index.ts'
import { SPEC_SYNC_SHARD_CRONS, specSyncShard } from './sync.ts'

describe('specSyncShard', () => {
  const shards = SPEC_SYNC_SHARD_CRONS.map((_, i) => specSyncShard(i))

  it('covers every registered provider exactly once', () => {
    const assigned = shards.flat().map((p) => p.id)
    expect(assigned.sort()).toEqual(providerRegistry.map((p) => p.id).sort())
    expect(new Set(assigned).size).toBe(assigned.length)
  })

  it('isolates fal in its own shard', () => {
    expect(shards[0]?.map((p) => p.id)).toEqual(['fal'])
  })

  it('spreads the rest across the remaining shards', () => {
    const restSizes = shards.slice(1).map((s) => s.length)
    const rest = providerRegistry.length - 1
    expect(restSizes.reduce((a, b) => a + b, 0)).toBe(rest)
    // Round-robin: shard sizes differ by at most one.
    expect(Math.max(...restSizes) - Math.min(...restSizes)).toBeLessThanOrEqual(
      1,
    )
  })

  it('keeps the wrangler.jsonc cron list in lockstep', async () => {
    const fs = await import('node:fs/promises')
    const raw = await fs.readFile('wrangler.jsonc', 'utf8')
    for (const cron of SPEC_SYNC_SHARD_CRONS) {
      expect(raw).toContain(`"${cron}"`)
    }
  })
})
