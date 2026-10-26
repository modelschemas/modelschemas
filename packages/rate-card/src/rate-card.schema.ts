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

// Every schema below that reaches JSON Schema (the service's OpenAPI document
// is written from this file) carries `.meta`. An `id` makes a named component.
// A `description` is there only where it tells a reader something the type
// does not: what a value means, its unit, or a rule that holds across fields.
// Agents read these, so none restates a field name.

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
          table: z
            .string()
            .meta({ description: 'A key of the card `tables`.' }),
          keys: z.array(exprSchema).min(1).meta({
            description: 'One key expression per table level, outermost first.',
          }),
          default: exprSchema.optional().meta({
            description: 'Used when a key is absent from the table.',
          }),
        }),
      }),
      z
        .partialRecord(
          z.enum(CORE_OPS),
          z.union([exprSchema, z.array(exprSchema)]),
        )
        .refine((ops) => Object.keys(ops).length === 1, 'one op per node')
        .meta({
          description:
            'Exactly one core op (var, missing, +, -, *, /, max, min, if, ==, !=, <, <=, >, >=, and, or, ceil, floor) applied to an expression or a list of them.',
        }),
    ]),
  )
  .meta({
    id: 'RateCardExpr',
    description:
      'JSONLogic expression over the closed op set: a literal, a `lookup` into a named table, or one op applied to its arguments.',
  })

const tableSchema: z.ZodType<Table> = z
  .lazy(() => z.record(z.string(), z.union([z.number(), tableSchema])))
  .meta({ id: 'RateCardTable' })

/** sha256 of fetched source text, plus where it came from. */
const sourceRefSchema = z
  .object({
    url: z.string().url(),
    hash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .meta({ description: 'sha256 of the fetched text.' }),
  })
  .meta({ id: 'RateCardSourceRef' })

// Named so the text appears once in the spec, not once per input kind.
const paramSchema = z.string().min(1).meta({
  id: 'RateCardParam',
  description:
    "Request-body or usage-object field this lever reads (`image_urls`). JSONLogic `{ var }` uses the input's object key, which may differ.",
})

const boundSchema = z.enum(['request', 'usage']).meta({
  id: 'RateCardBound',
  description:
    'Where `price` reads `param` from. request (the default): a real request-body field (`duration`, `image_size`). usage: a quantity the caller supplies because it is not on the request (`input_tokens`).',
})

const inputBase = { param: paramSchema, bound: boundSchema.optional() }

const numberInputSchema = z
  .object({
    ...inputBase,
    kind: z.literal('number'),
    default: z.number().optional(),
  })
  .meta({ id: 'RateCardNumberInput' })

const enumInputSchema = z
  .object({
    ...inputBase,
    kind: z.literal('enum'),
    values: z.array(z.string()).min(1),
    default: z.string().optional().meta({ description: 'One of `values`.' }),
  })
  .refine(
    (i) => i.default === undefined || i.values.includes(i.default),
    'default must be one of values',
  )
  .meta({ id: 'RateCardEnumInput' })

const booleanInputSchema = z
  .object({
    ...inputBase,
    kind: z.literal('boolean'),
    default: z.boolean().optional(),
  })
  .meta({ id: 'RateCardBooleanInput' })

const countInputSchema = z
  .object({ ...inputBase, kind: z.literal('count') })
  .meta({
    id: 'RateCardCountInput',
    description: 'Length of a list param (`image_urls`), 0 when absent.',
  })

const dimensionsInputSchema = z
  .object({
    ...inputBase,
    kind: z.literal('dimensions'),
    presets: z
      .record(z.string(), z.tuple([z.number(), z.number()]))
      .optional()
      .meta({ description: 'Preset name to [width, height].' }),
    levels: z.array(z.string()).optional().meta({
      description:
        "Names the provider sizes itself (Ark's `2K`); bound as `<name>.level`, with no width or height.",
    }),
    default: z
      .string()
      .optional()
      .meta({ description: 'A preset or level name.' }),
  })
  .refine(
    (i) =>
      i.default === undefined ||
      i.presets?.[i.default] !== undefined ||
      i.levels?.includes(i.default),
    'default must be a preset or level name',
  )
  .meta({
    id: 'RateCardDimensionsInput',
    description:
      'Takes `{width, height}`, a `WxH` string or a preset name, and binds `<name>.width` / `<name>.height`.',
  })

/** An estimate's own inputs: any kind, and none of them carries an estimate. */
const plainInputSchema = z
  .discriminatedUnion('kind', [
    numberInputSchema,
    enumInputSchema,
    booleanInputSchema,
    countInputSchema,
    dimensionsInputSchema,
  ])
  .meta({
    id: 'RateCardEstimateInput',
    description:
      'An input of an estimate: any kind except one with an estimate.',
  })

/** See `RateCardEstimate` in `card.ts`. */
const estimateSchema = z
  .object({
    inputs: z.record(z.string(), plainInputSchema).meta({
      description:
        'Bound only when the estimate runs. Names may not repeat a card input.',
    }),
    value: exprSchema.meta({
      description:
        "Expression yielding the estimated number; it also reads the card's own bound inputs.",
    }),
    source: sourceRefSchema,
  })
  .meta({
    id: 'RateCardEstimate',
    description:
      'The source-published way to estimate a number the caller did not supply. Used only when the input is absent; the result then names the input as estimated, never as a billed price. An input with an estimate has no default.',
  })

const estimatedNumberInputSchema = numberInputSchema
  .extend({ estimate: estimateSchema.optional() })
  .meta({ id: 'RateCardEstimatedNumberInput' })

/**
 * Kinds every input shares. `estimate` is the one extension, and only on a
 * top-level number input, so an estimate's own inputs cannot nest another.
 */
const inputSchema = z
  .discriminatedUnion('kind', [
    estimatedNumberInputSchema,
    enumInputSchema,
    booleanInputSchema,
    countInputSchema,
    dimensionsInputSchema,
  ])
  .meta({ id: 'RateCardInput' })

const rateCardExampleSchema = z
  .object({
    params: z.record(z.string(), z.unknown()).meta({
      description:
        "Flat bag of request-body fields plus usage quantities, keyed by each input's `param`. `verifyExamples` feeds it as both `request` and `usage`.",
    }),
    usd: z.number().positive().meta({
      description: "In the card's currency; the name predates `currency`.",
    }),
    quote: z.string().min(1).meta({
      description: 'The sentence in the source text this example comes from.',
    }),
  })
  .meta({ id: 'RateCardExample' })

/** See `RateCardPrice` in `card.ts`. */
const priceSchema = z
  .union([
    z
      .strictObject({
        currency: z.tuple([z.string(), exprSchema]),
      })
      .refine((price) => currencyWrapper(price) !== 'malformed')
      .meta({ id: 'RateCardCurrencyPrice' }),
    exprSchema,
  ])
  .meta({
    id: 'RateCardPrice',
    description:
      'Yields USD, or, wrapped as { currency: [ISO 4217 code, expression] }, that currency. The wrapper is the only place a card states a currency; any other spelling is refused, and an evaluator that does not know the wrapper refuses the card.',
  })

const sourceSchema = z
  .object({
    url: z.string().url(),
    hash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .meta({
        description: 'sha256 of the source text the card was read from.',
      }),
    // Real ISO dates: an LLM-emitted "soon" would never compare past `now`,
    // so a promo card would never be re-extracted.
    extractedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime().optional().meta({
      description: 'When the text names a promo end; re-extract after this.',
    }),
  })
  .meta({ id: 'RateCardSource' })

export const rateCardSchema = z
  .object({
    /** See `RateCard` in `card.ts`. */
    currency: z.never().optional(),
    inputs: z
      .record(z.string(), inputSchema)
      .superRefine((inputs, ctx) => {
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
      })
      .meta({
        description:
          'The levers the price reads, by the name `{ var }` uses in `price`.',
      }),
    tables: z.record(z.string(), tableSchema).meta({
      description: 'Named lookup tables for `{ lookup }` nodes in `price`.',
    }),
    price: priceSchema,
    examples: z.array(rateCardExampleSchema).meta({
      description:
        "The source page's own worked examples; the card is stored only if it reproduces every one.",
    }),
    source: sourceSchema,
  })
  .meta({
    id: 'RateCard',
    description:
      'A provider price as data: a JSONLogic expression over named inputs and lookup tables, checked against the source examples.',
  })
