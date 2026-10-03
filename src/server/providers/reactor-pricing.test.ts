import { describe, expect, it } from 'vitest'

import { compileReactorRate } from './reactor-pricing.ts'

const SOURCE = {
  url: 'https://api.reactor.inc/pricing',
  hash: 'abc',
  extractedAt: '2026-10-03T00:00:00.000Z',
}

describe('reactor pricing', () => {
  it('compiles a published USD per second and ignores credits', () => {
    const card = compileReactorRate(
      {
        amount_per_sec: 17,
        amount_per_sec_usd: '0.0017',
        currency_code: 'USD',
        unit: 'credits',
        denomination: 'second',
      },
      SOURCE,
    )
    expect(card?.price).toEqual({
      '*': [{ var: 'video_seconds' }, 0.0017],
    })
    expect(card?.inputs.video_seconds).toMatchObject({ bound: 'usage' })
  })

  it('stays null when only credits are published', () => {
    expect(
      compileReactorRate(
        { amount_per_sec: 17, unit: 'credits', denomination: 'second' },
        SOURCE,
      ),
    ).toBeNull()
    expect(
      compileReactorRate(
        {
          amount_per_sec: 350,
          amount_per_sec_usd: '0.0350',
          currency_code: 'CREDITS',
        },
        SOURCE,
      ),
    ).toBeNull()
  })
})
