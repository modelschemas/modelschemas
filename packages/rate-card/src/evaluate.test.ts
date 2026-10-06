import { describe, expect, it } from 'vitest'
import {
  RateCardError,
  bindInputs,
  cardCurrency,
  cardPrice,
  price,
  priceDetailed,
  verifyExamples,
} from './evaluate.ts'
import { z } from 'zod'

import { CORE_OPS, rateCardSchema } from './rate-card.schema.ts'
import type { Expr, RateCard } from './rate-card.schema.ts'

const source = {
  url: 'https://example.test/llms.txt',
  hash: 'a'.repeat(64),
  extractedAt: '2026-09-13T00:00:00Z',
}

/** A card whose price is `expr`, over number inputs `x` (default 4) and `y` (default 2). */
const cardFor = (expr: Expr, extra: Partial<RateCard> = {}): RateCard => ({
  inputs: {
    x: { param: 'x', kind: 'number', default: 4 },
    y: { param: 'y', kind: 'number', default: 2 },
  },
  tables: { t: { a: { p: 1.5 }, b: { p: 3 } } },
  price: expr,
  examples: [],
  source,
  ...extra,
})

const usd = (expr: Expr, params: Record<string, unknown> = {}) =>
  price(cardFor(expr), params)

describe('ops', () => {
  it.each<[string, Expr, number]>([
    ['+ variadic', { '+': [{ var: 'x' }, { var: 'y' }, 1] }, 7],
    ['- binary', { '-': [{ var: 'x' }, { var: 'y' }] }, 2],
    ['* variadic', { '*': [{ var: 'x' }, { var: 'y' }, 0.5] }, 4],
    ['/', { '/': [{ var: 'x' }, { var: 'y' }] }, 2],
    ['max', { max: [1, { var: 'x' }, 3] }, 4],
    ['min', { min: [{ var: 'x' }, 3, { var: 'y' }] }, 2],
    ['ceil', { ceil: [{ '/': [{ var: 'x' }, 3] }] }, 2],
    ['floor', { floor: [{ '/': [{ var: 'x' }, 3] }] }, 1],
    [
      'if chain',
      {
        if: [
          { '<': [{ var: 'x' }, 2] },
          10,
          { '<': [{ var: 'x' }, 5] },
          20,
          30,
        ],
      },
      20,
    ],
    ['== literal', { if: [{ '==': [{ var: 'x' }, 4] }, 1, 2] }, 1],
    ['!=', { if: [{ '!=': [{ var: 'x' }, 4] }, 1, 2] }, 2],
    ['<=', { if: [{ '<=': [{ var: 'x' }, 4] }, 1, 2] }, 1],
    ['>', { if: [{ '>': [{ var: 'x' }, 4] }, 1, 2] }, 2],
    ['>=', { if: [{ '>=': [{ var: 'x' }, 4] }, 1, 2] }, 1],
    ['and', { if: [{ and: [true, { '>': [{ var: 'x' }, 1] }] }, 1, 2] }, 1],
    ['or', { if: [{ or: [false, { '>': [{ var: 'x' }, 1] }] }, 1, 2] }, 1],
    [
      'missing → falsy when nothing is missing',
      { if: [{ missing: ['x'] }, 1, 2] },
      2,
    ],
    [
      'missing → truthy when something is',
      { if: [{ missing: ['x', 'nope'] }, 1, 2] },
      1,
    ],
    ['lookup nested', { lookup: { table: 't', keys: ['b', 'p'] } }, 3],
    [
      'lookup default',
      { lookup: { table: 't', keys: ['zzz'], default: 9 } },
      9,
    ],
  ])('%s', (_name, expr, expected) => {
    expect(usd(expr)).toBe(expected)
  })
})

describe('binding', () => {
  const card: RateCard = {
    inputs: {
      duration: { param: 'duration', kind: 'number', default: 5 },
      res: {
        param: 'resolution',
        kind: 'enum',
        values: ['480p', '720p'],
        default: '480p',
      },
      audio: { param: 'generate_audio', kind: 'boolean', default: true },
      refs: { param: 'image_urls', kind: 'count' },
      size: {
        param: 'image_size',
        kind: 'dimensions',
        presets: { square_hd: [1024, 1024] },
        default: 'square_hd',
      },
    },
    tables: {},
    price: 1,
    examples: [],
    source,
  }

  it('binds by request param name, falling back to defaults', () => {
    expect(bindInputs(card, {})).toEqual({
      duration: 5,
      res: '480p',
      audio: true,
      refs: 0,
      size: { width: 1024, height: 1024 },
    })
  })

  it('reads a numeric string duration, a list length and explicit pixels', () => {
    expect(
      bindInputs(card, {
        duration: '8',
        resolution: '720p',
        generate_audio: false,
        image_urls: ['a', 'b'],
        image_size: { width: 1920, height: 1080 },
      }),
    ).toEqual({
      duration: 8,
      res: '720p',
      audio: false,
      refs: 2,
      size: { width: 1920, height: 1080 },
    })
  })

  it('reads WxH as pixels and a level by name', () => {
    const c: RateCard = {
      ...card,
      inputs: {
        ...card.inputs,
        size: { param: 'image_size', kind: 'dimensions', levels: ['2K'] },
      },
    }
    expect(bindInputs(c, { image_size: '2048x1152' }).size).toEqual({
      width: 2048,
      height: 1152,
    })
    expect(bindInputs(c, { image_size: '2K' }).size).toEqual({ level: '2K' })
    expect(() => bindInputs(c, { image_size: '4K' })).toThrow(RateCardError)
  })

  it('var walks dotted paths into dimensions', () => {
    const c: RateCard = {
      ...card,
      price: { '*': [{ var: 'size.width' }, 0.001] },
    }
    expect(price(c, {})).toBe(1.024)
  })

  it.each<[string, Record<string, unknown>]>([
    ['enum outside values', { resolution: '1080p' }],
    ['non-numeric number', { duration: 'five' }],
    ['non-boolean boolean', { generate_audio: 'yes' }],
    ['non-list count', { image_urls: 'a' }],
    ['unknown size preset', { image_size: 'portrait_4_3' }],
  ])('refuses %s', (_name, params) => {
    expect(() => price(card, params)).toThrow(RateCardError)
  })
})

/** Outside the vocabulary; parsed so no assertion has to lie about its type. */
const unknownOp = JSON.parse('{"cat":[1,2]}') as Expr

describe('refusals', () => {
  it.each<[string, Expr, string]>([
    ['unknown op', unknownOp, 'unknown-op'],
    ['unbound var', { var: 'nope' }, 'unbound-var'],
    [
      'missing lookup key without default',
      { lookup: { table: 't', keys: ['zzz', 'p'] } },
      'missing-key',
    ],
    ['non-numeric operand', { '+': [{ var: 'x' }, 'text'] }, 'not-a-number'],
    // JSONLogic's == is loose; ours refuses a type mismatch instead of returning false.
    [
      '== across types',
      { if: [{ '==': [{ var: 'x' }, '4'] }, 1, 2] },
      'not-comparable',
    ],
    [
      '!= across types',
      { if: [{ '!=': [{ var: 'x' }, '4'] }, 1, 2] },
      'not-comparable',
    ],
    [
      '== on a list',
      { if: [{ '==': [{ missing: ['x'] }, 0] }, 1, 2] },
      'not-comparable',
    ],
    ['zero price', { '-': [{ var: 'x' }, 4] }, 'bad-result'],
    ['negative price', { '-': [1, { var: 'x' }] }, 'bad-result'],
    ['non-finite price', { '/': [{ var: 'x' }, 0] }, 'bad-result'],
    ['non-numeric price', { '<': [1, 2] }, 'bad-result'],
  ])('%s', (_name, expr, code) => {
    expect(() => usd(expr)).toThrow(expect.objectContaining({ code }))
  })

  const doubleX: Expr = { '*': [{ var: 'x' }, 2] }
  const yuan = { ...cardFor(doubleX), price: { currency: ['CNY', doubleX] } }

  it('prices a card in its own currency and never calls it USD', () => {
    const parsed = rateCardSchema.parse(yuan)
    expect(cardCurrency(parsed)).toBe('CNY')
    expect(priceDetailed(parsed)).toEqual({
      amount: 8,
      currency: 'CNY',
      estimated: [],
    })
    // The wrapper changes the label, never the amount.
    expect(price(parsed)).toBe(price(cardFor(doubleX)))
    // A bare price is USD: a card stored before currencies reads unchanged.
    expect(cardCurrency(cardFor(1))).toBe('USD')
    expect(priceDetailed(cardFor(1))).toMatchObject({ currency: 'USD', usd: 1 })
  })

  it.each(['yuan', 'cny', '¥', 'RMBX', ''])(
    'schema rejects %j as a currency',
    (currency) => {
      const card = { ...cardFor(1), price: { currency: [currency, 1] } }
      expect(rateCardSchema.safeParse(card).success).toBe(false)
    },
  )

  it('schema takes the currency wrapper at the root of price only', () => {
    const nested = { '+': [1, { currency: ['CNY', 1] }] }
    expect(
      rateCardSchema.safeParse({ ...cardFor(1), price: nested }).success,
    ).toBe(false)
    const beside = { currency: ['CNY', 1], '+': [1, 2] }
    expect(
      rateCardSchema.safeParse({ ...cardFor(1), price: beside }).success,
    ).toBe(false)
  })

  it('schema refuses a top-level currency rather than read the card as USD', () => {
    for (const currency of ['CNY', 'USD', null, 156]) {
      expect(
        rateCardSchema.safeParse({ ...cardFor(1), currency }).success,
      ).toBe(false)
    }
  })

  it('schema refuses a USD wrapper: USD is said only by having none', () => {
    const card = { ...cardFor(1), price: { currency: ['USD', 1] } }
    expect(rateCardSchema.safeParse(card).success).toBe(false)
  })

  // Wrappers the schema refuses, handed to the evaluator unparsed.
  it.each([
    ['a lowercase code', { currency: ['cny', 1] }],
    ['a numeric code', { currency: [156, 1] }],
    ['USD', { currency: ['USD', 1] }],
    ['three items', { currency: ['CNY', 1, 2] }],
    ['a sibling op', { currency: ['CNY', 1], '+': [1, 2] }],
    ['a bare code', { currency: 'CNY' }],
    ['no price', undefined],
    ['a null price', null],
    ['a null wrapper payload', { currency: null }],
    ['a null wrapped expression', { currency: ['CNY', null] }],
  ])('evaluator refuses %s with its own error', (_name, bad) => {
    const card = { ...cardFor(1), price: bad } as unknown as RateCard
    expect(rateCardSchema.safeParse(card).success).toBe(false)
    for (const read of [cardPrice, cardCurrency, price, priceDetailed]) {
      expect(() => read(card)).toThrow(RateCardError)
      expect(() => read(card)).toThrow(
        expect.objectContaining({ code: 'unknown-op' }),
      )
    }
  })

  it('evaluator refuses a stray top-level currency on an unparsed card', () => {
    const card = { ...cardFor(1), currency: 'CNY' } as unknown as RateCard
    for (const read of [cardCurrency, price, priceDetailed]) {
      expect(() => read(card)).toThrow(
        expect.objectContaining({ code: 'unknown-op' }),
      )
    }
  })

  it('evaluator refuses a null card with its own error', () => {
    expect(() => cardCurrency(null as unknown as RateCard)).toThrow(
      RateCardError,
    )
  })

  /**
   * What @modelschemas/rate-card 0.1.0 (and a service rolled back to before
   * currencies) does with an expression node: its schema accepts only the
   * ops below, and its evaluator throws `unknown-op` on any other key. The
   * op list is the published one, frozen here on purpose.
   */
  const OPS_0_1_0 = [
    ...['var', 'missing', '+', '-', '*', '/', 'max', 'min', 'if'],
    ...['==', '!=', '<', '<=', '>', '>=', 'and', 'or', 'ceil', 'floor'],
  ]
  const expr010: z.ZodType = z.lazy(() =>
    z.union([
      z.number(),
      z.string(),
      z.boolean(),
      z.strictObject({ lookup: z.unknown() }),
      z
        .partialRecord(z.enum(OPS_0_1_0), z.union([expr010, z.array(expr010)]))
        .refine((ops) => Object.keys(ops).length === 1, 'one op per node'),
    ]),
  )

  it('a pre-currency evaluator refuses a non-USD card instead of calling it dollars', () => {
    // It reads USD cards as before, so the reproduction is not just strict.
    expect(expr010.safeParse(doubleX).success).toBe(true)
    expect(expr010.safeParse(yuan.price).success).toBe(false)
    // Its evaluator would throw `unknown-op` on the root key.
    expect(Object.keys(yuan.price)).toEqual(['currency'])
    expect(OPS_0_1_0).not.toContain('currency')
    // The op must never become a core op, or old schemas that are handed
    // the new list would start reading yuan as dollars.
    expect(CORE_OPS).toEqual(OPS_0_1_0)
  })

  it('schema rejects an op outside the vocabulary', () => {
    expect(rateCardSchema.safeParse(cardFor(unknownOp)).success).toBe(false)
  })

  it('schema rejects a lookup node carrying a sibling op (would be stripped silently)', () => {
    const expr = JSON.parse(
      '{"lookup":{"table":"t","keys":["a","p"]},"+":[1,2]}',
    ) as Expr
    expect(rateCardSchema.safeParse(cardFor(expr)).success).toBe(false)
  })

  it.each<[string, Partial<RateCard>]>([
    [
      'enum default outside values',
      {
        inputs: {
          r: { param: 'r', kind: 'enum', values: ['a'], default: 'zzz' },
        },
      },
    ],
    [
      'dimensions default that is not a preset',
      {
        inputs: {
          s: { param: 's', kind: 'dimensions', presets: {}, default: 'nope' },
        },
      },
    ],
    [
      'extractedAt that is not a date',
      { source: { ...source, extractedAt: 'yesterday' } },
    ],
    [
      'expiresAt that is not a date',
      { source: { ...source, expiresAt: 'soon' } },
    ],
  ])('schema rejects %s', (_name, extra) => {
    expect(rateCardSchema.safeParse(cardFor(1, extra)).success).toBe(false)
  })
})

describe('verifyExamples', () => {
  const expr: Expr = { '*': [{ var: 'x' }, 0.1] }
  it('passes within 1% and fails outside it, reporting the priced USD', () => {
    const card = cardFor(expr, {
      examples: [
        { params: { x: 10 }, usd: 1.0, quote: 'ten' },
        { params: { x: 10 }, usd: 1.009, quote: 'ten-ish' },
        { params: { x: 10 }, usd: 1.02, quote: 'not ten' },
      ],
    })
    const [exact, close, off] = verifyExamples(card)
    expect(exact).toMatchObject({ ok: true, usd: 1 })
    expect(close).toMatchObject({ ok: true })
    expect(off).toMatchObject({
      ok: false,
      usd: 1,
      error: expect.stringContaining('1.02') as string,
    })
  })

  it('reports a refusal as a failed example instead of throwing', () => {
    const card = cardFor(expr, {
      examples: [{ params: { x: 'many' }, usd: 1, quote: 'bad input' }],
    })
    expect(verifyExamples(card)[0]).toMatchObject({
      ok: false,
      error: expect.stringContaining('bad-input') as string,
    })
  })
})

describe('estimate', () => {
  // rate × tokens; tokens estimated as seconds × per-second[resolution].
  const card: RateCard = {
    inputs: {
      resolution: { param: 'resolution', kind: 'enum', values: ['480p'] },
      tokens: {
        param: 'tokens',
        bound: 'usage',
        kind: 'number',
        estimate: {
          inputs: { seconds: { param: 'seconds', kind: 'number' } },
          value: {
            '*': [
              { var: 'seconds' },
              {
                lookup: { table: 'per_second', keys: [{ var: 'resolution' }] },
              },
            ],
          },
          source: { url: 'https://example.test/guide', hash: 'b'.repeat(64) },
        },
      },
    },
    tables: { per_second: { '480p': 1000 } },
    price: { '*': [{ var: 'tokens' }, 0.001] },
    examples: [],
    source,
  }

  it('prices supplied usage as billed, without the estimate inputs', () => {
    expect(rateCardSchema.parse(card)).toEqual(card)
    expect(
      priceDetailed(card, { resolution: '480p' }, { tokens: 500 }),
    ).toEqual({ amount: 0.5, currency: 'USD', usd: 0.5, estimated: [] })
  })

  it('labels an estimated input and binds its own inputs only then', () => {
    expect(priceDetailed(card, { resolution: '480p', seconds: 2 }, {})).toEqual(
      { amount: 2, currency: 'USD', usd: 2, estimated: ['tokens'] },
    )
    expect(() => priceDetailed(card, { resolution: '480p' }, {})).toThrow(
      /tokens \(tokens\): not supplied, and cannot be estimated.*seconds.*required/,
    )
  })

  it('never estimates through price(), the billed entry point', () => {
    expect(price(card, { resolution: '480p' }, { tokens: 500 })).toBe(0.5)
    expect(() => price(card, { resolution: '480p', seconds: 2 }, {})).toThrow(
      /tokens \(tokens\): required/,
    )
  })

  it('refuses a non-positive estimate rather than pricing it', () => {
    expect(() =>
      priceDetailed(card, { resolution: '480p', seconds: -1 }, {}),
    ).toThrow(
      expect.objectContaining({ code: 'estimate-unavailable' }) as Error,
    )
  })

  it('rejects an estimate beside a default, or shadowing a card input', () => {
    const tokens = card.inputs.tokens
    if (tokens?.kind !== 'number' || !tokens.estimate) throw new Error('shape')
    const withDefault = {
      ...card,
      inputs: { ...card.inputs, tokens: { ...tokens, default: 1 } },
    }
    expect(rateCardSchema.safeParse(withDefault).success).toBe(false)
    const shadowing = {
      ...card,
      inputs: {
        ...card.inputs,
        tokens: {
          ...tokens,
          estimate: {
            ...tokens.estimate,
            inputs: {
              resolution: { param: 'resolution', kind: 'enum', values: ['1'] },
            },
          },
        },
      },
    }
    expect(rateCardSchema.safeParse(shadowing).success).toBe(false)
  })
})
