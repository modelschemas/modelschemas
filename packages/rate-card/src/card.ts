/**
 * The rate-card expression language as plain TypeScript: the types, the
 * closed op set and the currency wrapper rule. No runtime dependencies, so
 * the evaluator runs on any edge runtime. `rate-card.schema.ts` is the zod
 * schema for the same shape; a type test keeps the two equal.
 */

/**
 * The version of the card language this package reads. The package's
 * MAJOR.MINOR version is this version: a change to what a card can say (a
 * new op, a new wrapper) bumps both, and a fix that reads the same cards is
 * a patch release.
 *
 * - `0.1`: the core ops, `lookup` and input `estimate`s. USD only.
 * - `0.2`: the `{ currency: [code, expr] }` price wrapper.
 */
export const RATE_CARD_LANGUAGE = '0.2'

export const CORE_OPS = [
  'var',
  'missing',
  '+',
  '-',
  '*',
  '/',
  'max',
  'min',
  'if',
  '==',
  '!=',
  '<',
  '<=',
  '>',
  '>=',
  'and',
  'or',
  'ceil',
  'floor',
] as const

export type CoreOp = (typeof CORE_OPS)[number]

export type Expr =
  | number
  | string
  | boolean
  | { lookup: { table: string; keys: Expr[]; default?: Expr } }
  | { [op in CoreOp]?: Expr | Expr[] }

/** Nested numeric lookup: `tables.rate['720p'].video` → number. */
export type Table = { [key: string]: number | Table }

type InputBase = {
  /**
   * Request-body or usage-object field this lever reads (`image_urls`).
   * JSONLogic `{ var }` uses the input's object key, which may differ.
   */
  param: string
  /**
   * Where `price` reads `param` from: a real request-body field
   * (`duration`, `image_size`; the default) or a usage quantity the caller
   * supplies because it is not on the request (`input_tokens`).
   */
  bound?: 'request' | 'usage'
}

/** sha256 of fetched source text, plus where it came from. */
type SourceRef = { url: string; hash: string }

/** An input kind every input shares. Only a card input has an `estimate`. */
export type RateCardPlainInput =
  | (InputBase & { kind: 'number'; default?: number })
  | (InputBase & { kind: 'enum'; values: string[]; default?: string })
  | (InputBase & { kind: 'boolean'; default?: boolean })
  /** Length of a list param (`image_urls`), 0 when absent. */
  | (InputBase & { kind: 'count' })
  /**
   * `{width, height}`, a `WxH` string or a preset name; binds
   * `<name>.width` / `<name>.height`. A `levels` name (Ark's `2K`, sized
   * by the provider) binds `<name>.level` instead, with no width or height.
   */
  | (InputBase & {
      kind: 'dimensions'
      presets?: Record<string, [number, number]>
      levels?: string[]
      default?: string
    })

/**
 * A source-published way to estimate a number the caller did not supply
 * (`completion_tokens` from resolution × ratio × duration). Used only when
 * the input is absent; the result then names the input as estimated, never
 * as a billed price. `inputs` bind only on that path, so a caller who
 * supplies the real number is not asked for them. `value` also reads the
 * card's own bound inputs; estimate input names may not repeat them, and
 * an input with an estimate has no `default` (which would silently win).
 */
export type RateCardEstimate = {
  inputs: Record<string, RateCardPlainInput>
  value: Expr
  /** The text the estimate method was read from. */
  source: SourceRef
}

export type RateCardInput =
  | Exclude<RateCardPlainInput, { kind: 'number' }>
  | (InputBase & {
      kind: 'number'
      default?: number
      estimate?: RateCardEstimate
    })

export type RateCardExample = {
  /**
   * Flat bag of request-body fields plus usage quantities, keyed by each
   * input's `param`. `verifyExamples` feeds it as both `request` and `usage`.
   */
  params: Record<string, unknown>
  /** In the card's currency; the name predates `currency`. */
  usd: number
  /** The sentence in the source text this example comes from. */
  quote: string
}

/**
 * JSONLogic yielding the amount for one request: USD, or, wrapped as
 * `{ currency: ['CNY', expr] }`, the ISO-4217 currency named. The wrapper
 * is the only place a card states a currency, so a USD card is exactly
 * what it was before cards had one.
 *
 * `currency` is deliberately not a core op. An evaluator that predates it
 * (0.1.0, or a rolled-back service) fails to parse the card and throws
 * `unknown-op` on its price, so it refuses a yuan amount instead of
 * reporting it as dollars. Amounts in different currencies are never
 * added, compared or converted.
 */
export type RateCardPrice = { currency: [string, Expr] } | Expr

export type RateCard = {
  /**
   * Not a field. A card that states its currency here instead of wrapping
   * `price` is refused, never read as USD.
   */
  currency?: undefined
  inputs: Record<string, RateCardInput>
  tables: Record<string, Table>
  price: RateCardPrice
  examples: RateCardExample[]
  source: {
    url: string
    /** sha256 of the source text the card was read from. */
    hash: string
    /** ISO date-time. */
    extractedAt: string
    /** When the text names a promo end — re-extract after this. */
    expiresAt?: string
  }
}

/**
 * The one rule for a price's currency wrapper, shared by the schema and
 * the evaluator: `null` for a bare (USD) price, the code and inner
 * expression for `{ currency: ['CNY', expr] }`, `'malformed'` for anything
 * else carrying a `currency` key. The code is three capitals and never
 * `USD`: USD is said only by having no wrapper, so a USD card can never
 * become one that 0.1.0 refuses.
 */
export function currencyWrapper(
  price: unknown,
): { currency: string; expr: unknown } | null | 'malformed' {
  if (typeof price !== 'object' || price === null || !('currency' in price)) {
    return null
  }
  const pair = price.currency
  if (
    Object.keys(price).length !== 1 ||
    !Array.isArray(pair) ||
    pair.length !== 2 ||
    typeof pair[0] !== 'string' ||
    !/^[A-Z]{3}$/.test(pair[0]) ||
    pair[0] === 'USD' ||
    pair[1] == null
  ) {
    return 'malformed'
  }
  return { currency: pair[0], expr: pair[1] }
}
