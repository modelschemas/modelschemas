import { describe, expect, it } from 'vitest'

import { compileTokenCard } from '@modelschemas/rate-card'
import type { RateCard } from '@modelschemas/rate-card'

import { changedFactPaths, modelUpdatedPayload } from './change-facts.ts'
import { updateStormOf } from './docs-failing.ts'

const source = {
  url: 'https://example.com/pricing',
  hash: 'a'.repeat(64),
  extractedAt: '2026-01-01T00:00:00.000Z',
}

function card(
  rates: Record<string, number>,
  stamp: { hash: string; extractedAt: string } = source,
): RateCard {
  const compiled = compileTokenCard(rates, [], { ...source, ...stamp })
  if (!compiled) throw new Error('card did not compile')
  return compiled
}

describe('changedFactPaths', () => {
  it('ignores source stamps, key order, and + operand order', () => {
    const before = card({
      input_tokens: 1,
      cache_read_tokens: 0.1,
      output_tokens: 2,
    })
    const after = card(
      { output_tokens: 2, input_tokens: 1, cache_read_tokens: 0.1 },
      { hash: 'b'.repeat(64), extractedAt: '2026-10-13T00:00:00.000Z' },
    )
    expect(changedFactPaths({ pricing: before }, { pricing: after })).toEqual(
      [],
    )
  })

  it('ignores an estimate source stamp and values order', () => {
    const hash = 'c'.repeat(64)
    const estimate = {
      inputs: {
        ratio: {
          param: 'ratio',
          kind: 'enum' as const,
          values: ['16:9', '1:1', '9:16'],
          default: '16:9',
        },
      },
      value: { var: 'ratio' },
      source: { url: 'https://example.com/est', hash },
    }
    const before: RateCard = {
      ...card({ input_tokens: 1, output_tokens: 2 }),
      inputs: {
        resolution: {
          param: 'resolution',
          kind: 'enum',
          values: ['720p', '1080p'],
          default: '720p',
        },
        output_tokens: {
          param: 'output_tokens',
          kind: 'number',
          estimate,
        },
      },
    }
    const after: RateCard = structuredClone(before)
    after.source = {
      ...after.source,
      hash: 'd'.repeat(64),
      extractedAt: '2026-10-13T00:00:00.000Z',
    }
    const resolution = after.inputs.resolution
    if (resolution?.kind === 'enum') resolution.values = ['1080p', '720p']
    const output = after.inputs.output_tokens
    if (output?.kind === 'number' && output.estimate) {
      output.estimate.source = {
        ...output.estimate.source,
        hash: 'e'.repeat(64),
      }
      const ratio = output.estimate.inputs.ratio
      if (ratio?.kind === 'enum') ratio.values = ['9:16', '16:9', '1:1']
    }
    const price: unknown = after.price
    if (
      typeof price === 'object' &&
      price !== null &&
      '+' in price &&
      Array.isArray(price['+'])
    ) {
      price['+'].reverse()
    }
    expect(changedFactPaths({ pricing: before }, { pricing: after })).toEqual(
      [],
    )
    const stamped = {
      pricing: {
        inputs: {
          n: {
            kind: 'number',
            param: 'n',
            estimate: {
              inputs: {},
              value: 1,
              source: {
                url: 'https://example.com/est',
                hash,
                extractedAt: '2026-01-01T00:00:00.000Z',
              },
            },
          },
        },
      },
    }
    const restamped = structuredClone(stamped)
    restamped.pricing.inputs.n.estimate.source.hash = 'e'.repeat(64)
    restamped.pricing.inputs.n.estimate.source.extractedAt =
      '2026-10-13T00:00:00.000Z'
    expect(changedFactPaths(stamped, restamped)).toEqual([])
  })

  it('reports a rate, a term, and expiresAt', () => {
    const before = card({ input_tokens: 1, output_tokens: 2 })
    const raised = card({ input_tokens: 5, output_tokens: 2 })
    expect(
      changedFactPaths({ pricing: before }, { pricing: raised }),
    ).toContain('pricing.tables.rate.base.input_tokens')

    const extra = card({
      input_tokens: 1,
      output_tokens: 2,
      cache_read_tokens: 0.1,
    })
    const added = changedFactPaths({ pricing: before }, { pricing: extra })
    expect(added.some((path) => path.includes('cache_read_tokens'))).toBe(true)
    const removed = changedFactPaths({ pricing: extra }, { pricing: before })
    expect(removed.some((path) => path.includes('cache_read_tokens'))).toBe(
      true,
    )

    const dated = structuredClone(before)
    dated.source = { ...dated.source, expiresAt: '2026-12-01T00:00:00.000Z' }
    expect(changedFactPaths({ pricing: before }, { pricing: dated })).toEqual([
      'pricing.source.expiresAt',
    ])
  })

  it('sorts paths and names a non-price fact', () => {
    expect(
      changedFactPaths(
        { contextWindow: 100, displayName: 'A' },
        { contextWindow: 200, displayName: 'B' },
      ),
    ).toEqual(['contextWindow', 'displayName'])
  })

  it('refuses an empty changed list', () => {
    expect(() => modelUpdatedPayload({ a: 1 }, { a: 1 }, [])).toThrow(
      /changed fact/,
    )
    expect(modelUpdatedPayload({ a: 1 }, { a: 2 }, ['a'])).toEqual({
      before: { a: 1 },
      after: { a: 2 },
      changed: ['a'],
    })
  })
})

describe('updateStormOf', () => {
  it('marks more than half of the live rows, at least 20', () => {
    expect(updateStormOf(21, 40)).toEqual({ updated: 21, live: 40 })
    expect(updateStormOf(20, 40)).toBeNull()
    expect(updateStormOf(19, 19)).toBeNull()
    expect(updateStormOf(20, 20)).toEqual({ updated: 20, live: 20 })
  })
})
