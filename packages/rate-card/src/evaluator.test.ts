import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, expectTypeOf, it } from 'vitest'
import type { z } from 'zod'

import type { RateCard } from './card.ts'
import { RATE_CARD_LANGUAGE, evaluateCard } from './evaluator.ts'
import {
  ESTIMATE_CASES,
  packageExpected,
  settle,
} from './fixtures/estimate-cases.ts'
import type { rateCardSchema } from './rate-card.schema.ts'

describe('evaluateCard', () => {
  it.each(ESTIMATE_CASES.map((c) => [c.name, c] as const))('%s', (_, c) => {
    expect(
      settle(() =>
        evaluateCard(c.card, { request: c.request, usage: c.usage }),
      ),
    ).toEqual(packageExpected(c))
  })

  it('takes no inputs for a card whose inputs all have defaults', () => {
    const card: RateCard = {
      inputs: { n: { param: 'n', kind: 'number', default: 2 } },
      tables: {},
      price: { '*': [{ var: 'n' }, 0.5] },
      examples: [],
      source: {
        url: 'https://example.com/pricing',
        hash: 'a'.repeat(64),
        extractedAt: '2026-10-01T00:00:00Z',
      },
    }
    expect(evaluateCard(card)).toEqual({
      amount: 1,
      currency: 'USD',
      estimated: [],
    })
  })
})

describe('the evaluator entry', () => {
  it('parses cards to exactly the zod-free RateCard type', () => {
    expectTypeOf<z.infer<typeof rateCardSchema>>().toExtend<RateCard>()
    expectTypeOf<RateCard>().toExtend<z.infer<typeof rateCardSchema>>()
  })

  it('is versioned with the card language: MAJOR.MINOR is RATE_CARD_LANGUAGE', () => {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'),
    ) as { version: string }
    expect(manifest.version.split('.').slice(0, 2).join('.')).toBe(
      RATE_CARD_LANGUAGE,
    )
  })
})
