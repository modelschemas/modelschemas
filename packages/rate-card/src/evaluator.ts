/**
 * `@modelschemas/rate-card/evaluator`: the evaluator with no runtime
 * dependencies, for edge runtimes and clients that price cards they fetched
 * from `GET /v1/models/{provider}/{id}`. The package root adds the zod
 * schema and the listing compilers.
 */
import { priceDetailed } from './evaluate.ts'
import type { RateCard } from './card.ts'
import { normalizeUsage } from './usage.ts'

export { CORE_OPS, RATE_CARD_LANGUAGE } from './card.ts'
export type {
  CoreOp,
  Expr,
  RateCard,
  RateCardEstimate,
  RateCardExample,
  RateCardInput,
  RateCardPlainInput,
  RateCardPrice,
  Table,
} from './card.ts'
export {
  RateCardError,
  bindInputs,
  cardCurrency,
  cardParams,
  cardPrice,
  price,
  priceDetailed,
  verifyExamples,
} from './evaluate.ts'
export type {
  ExampleResult,
  PriceResult,
  RateCardErrorCode,
} from './evaluate.ts'
export { normalizeUsage, usageFormat } from './usage.ts'
export type { UsageFormat } from './usage.ts'

export interface CardEvaluation {
  /** The price, in `currency`. Never converted. */
  amount: number
  /** ISO-4217 code `amount` is in. */
  currency: string
  /**
   * Params the caller omitted that the card's published `estimate` filled.
   * Empty means `amount` is the price as billed.
   */
  estimated: string[]
}

/**
 * What `POST /v1/estimate` returns for the same card and inputs. `usage`
 * is card levers or the provider's own usage object (`normalizeUsage`).
 * Throws `RateCardError` rather than return a number it cannot stand
 * behind.
 */
export function evaluateCard(
  card: RateCard,
  {
    request = {},
    usage = {},
  }: {
    request?: Record<string, unknown>
    usage?: Record<string, unknown>
  } = {},
): CardEvaluation {
  const { amount, currency, estimated } = priceDetailed(
    card,
    request,
    normalizeUsage(card, usage),
  )
  return { amount, currency, estimated }
}
