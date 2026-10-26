/**
 * Rate card — a provider's advertised price as data, evaluated
 * deterministically against a request (and, for token-priced models, the
 * usage the caller supplies).
 *
 * A card is JSONLogic (a published spec LLMs already know; pure data, no code
 * execution, Workers-safe) over a closed vocabulary: the core ops in `card.ts` plus
 * `lookup` (named tables) and `ceil` / `floor`. `examples` are the source
 * page's own worked examples; `verifyExamples` must reproduce every one or
 * the card is rejected.
 */
import { z } from 'zod'

import { CORE_OPS, currencyWrapper } from './card.ts'
import type { Expr, Table } from './card.ts'

const exprSchema: z.ZodType<Expr> = z
  .lazy(() =>
    z.union([
      z.number(),
      z.string(),
      z.boolean(),
      // strict: a sibling core op next to `lookup` would otherwise be stripped
      // silently, storing a different price than written.
      z.strictObject({
        lookup: z.strictObject({
          table: z.string(),
          keys: z.array(exprSchema).min(1),
          default: exprSchema.optional(),
        }),
      }),
      z
        .partialRecord(
          z.enum(CORE_OPS),
          z.union([exprSchema, z.array(exprSchema)]),
        )
        .refine((ops) => Object.keys(ops).length === 1, 'one op per node'),
    ]),
  )
  .meta({
    id: 'RateCardExpr',
    description:
      'JSONLogic expression over the closed op set: a literal, a `lookup` into a named table, or one op applied to its arguments.',
  })

const tableSchema: z.ZodType<Table> = z
  .lazy(() => z.record(z.string(), z.union([z.number(), tableSchema])))
  .meta({
    id: 'RateCardTable',
    description: 'A named lookup table: numbers, nested to any depth.',
  })

const inputBase = {
  /**
   * Request-body or usage-object field this lever reads (`image_urls`).
   * JSONLogic `{ var }` uses the input's object key, which may differ.
   */
  param: z.string().min(1),
  /**
   * Where `price` reads `param` from: a real request-body field
   * (`duration`, `image_size`; the default) or a usage quantity the caller
   * supplies because it is not on the request (`input_tokens`).
   */
  bound: z.enum(['request', 'usage']).optional(),
}

/** sha256 of fetched source text, plus where it came from. */
const sourceRefSchema = z
  .object({
    url: z.string().url(),
    hash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .meta({ id: 'RateCardSourceRef' })

/**
 * Kinds every input shares. `estimate` is the one extension, and only on a
 * top-level number input, so an estimate's own inputs cannot nest another.
 */
function inputKinds<TNumber extends z.ZodRawShape>(numberExtra: TNumber) {
  return z.discriminatedUnion('kind', [
    z.object({
      ...inputBase,
      kind: z.literal('number'),
      default: z.number().optional(),
      ...numberExtra,
    }),
    z
      .object({
        ...inputBase,
        kind: z.literal('enum'),
        values: z.array(z.string()).min(1),
        default: z.string().optional(),
      })
      .refine(
        (i) => i.default === undefined || i.values.includes(i.default),
        'default must be one of values',
      ),
    z.object({
      ...inputBase,
      kind: z.literal('boolean'),
      default: z.boolean().optional(),
    }),
    /** Length of a list param (`image_urls`), 0 when absent. */
    z.object({ ...inputBase, kind: z.literal('count') }),
    /**
     * `{width, height}`, a `WxH` string or a preset name; binds
     * `<name>.width` / `<name>.height`. A `levels` name (Ark's `2K`, sized
     * by the provider) binds `<name>.level` instead, with no width or height.
     */
    z
      .object({
        ...inputBase,
        kind: z.literal('dimensions'),
        presets: z
          .record(z.string(), z.tuple([z.number(), z.number()]))
          .optional(),
        levels: z.array(z.string()).optional(),
        default: z.string().optional(),
      })
      .refine(
        (i) =>
          i.default === undefined ||
          i.presets?.[i.default] !== undefined ||
          i.levels?.includes(i.default),
        'default must be a preset or level name',
      ),
  ])
}

const plainInputSchema = inputKinds({}).meta({
  id: 'RateCardEstimateInput',
  description: 'An input of an estimate: any kind except one with an estimate.',
})

/** See `RateCardEstimate` in `card.ts`. */
const estimateSchema = z
  .object({
    inputs: z.record(z.string(), plainInputSchema),
    value: exprSchema,
    /** The text the estimate method was read from. */
    source: sourceRefSchema,
  })
  .meta({
    id: 'RateCardEstimate',
    description:
      'Number inputs only: the source-published way to estimate the value when the caller omits it. Its own inputs bind only then.',
  })

const inputSchema = inputKinds({ estimate: estimateSchema.optional() }).meta({
  id: 'RateCardInput',
  description:
    'A lever the price reads: a number, enum, boolean, list count or dimensions.',
})

const rateCardExampleSchema = z
  .object({
    /**
     * Flat bag of request-body fields plus usage quantities, keyed by each
     * input's `param`. `verifyExamples` feeds it as both `request` and `usage`.
     */
    params: z.record(z.string(), z.unknown()),
    /** In the card's currency; the name predates `currency`. */
    usd: z.number().positive(),
    /** The sentence in the source text this example comes from. */
    quote: z.string().min(1),
  })
  .meta({
    id: 'RateCardExample',
    description: "A worked example from the source page's own text.",
  })

/** See `RateCardPrice` in `card.ts`. */
const priceSchema = z
  .union([
    z
      .strictObject({ currency: z.tuple([z.string(), exprSchema]) })
      .refine((price) => currencyWrapper(price) !== 'malformed')
      .meta({
        id: 'RateCardCurrencyPrice',
        description:
          'A price in another currency: { currency: [ISO 4217 code, expression] }. Any other currency spelling is refused.',
      }),
    exprSchema,
  ])
  .meta({
    id: 'RateCardPrice',
    description:
      'The price expression, yielding USD, or wrapped in { currency: [code, expression] } for another currency.',
  })

export const rateCardSchema = z
  .object({
    /** See `RateCard` in `card.ts`. */
    currency: z.never().optional(),
    inputs: z.record(z.string(), inputSchema).superRefine((inputs, ctx) => {
      for (const [name, input] of Object.entries(inputs)) {
        if (input.kind !== 'number' || !input.estimate) continue
        if (input.default !== undefined) {
          ctx.addIssue({
            code: 'custom',
            path: [name],
            message: 'an input with an estimate cannot have a default',
          })
        }
        for (const shadowed of Object.keys(input.estimate.inputs)) {
          if (shadowed in inputs) {
            ctx.addIssue({
              code: 'custom',
              path: [name, 'estimate', 'inputs', shadowed],
              message: 'estimate input repeats a card input name',
            })
          }
        }
      }
    }),
    tables: z.record(z.string(), tableSchema),
    price: priceSchema,
    examples: z.array(rateCardExampleSchema),
    source: z
      .object({
        url: z.string().url(),
        /** sha256 of the source text the card was read from. */
        hash: z.string().regex(/^[0-9a-f]{64}$/),
        // Real ISO dates: an LLM-emitted "soon" would never compare past `now`,
        // so a promo card would never be re-extracted.
        extractedAt: z.iso.datetime(),
        /** When the text names a promo end — re-extract after this. */
        expiresAt: z.iso.datetime().optional(),
      })
      .meta({
        id: 'RateCardSource',
        description: 'Where the card was read from.',
      }),
  })
  .meta({
    id: 'RateCard',
    description:
      'A provider price as data: a JSONLogic expression over named inputs and lookup tables, checked against the source examples.',
  })
