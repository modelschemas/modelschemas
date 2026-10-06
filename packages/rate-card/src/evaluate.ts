/**
 * Deterministic rate-card evaluator. ~100 lines of JSONLogic over
 * the closed vocabulary in `rate-card.schema.ts` — smaller than json-logic-js,
 * no `eval`, and it refuses instead of coercing: an unknown op, an unbound
 * input, a missing table key or a non-numeric operand throws, and so does a
 * price that is not a finite positive number. A refusal is an honest
 * "unknown"; a made-up number is a wrong price.
 */
import { CORE_OPS, currencyWrapper } from './rate-card.schema.ts'
import type {
  CoreOp,
  Expr,
  RateCard,
  RateCardEstimate,
  RateCardExample,
  Table,
} from './rate-card.schema.ts'

export type RateCardErrorCode =
  | 'unknown-op'
  | 'unbound-var'
  | 'bad-input'
  | 'missing-key'
  | 'not-a-number'
  | 'not-comparable'
  | 'bad-result'
  | 'estimate-unavailable'

export class RateCardError extends Error {
  constructor(
    readonly code: RateCardErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'RateCardError'
  }
}

type Vars = Record<string, unknown>

/**
 * A card's currency and the expression that yields the amount in it. Safe
 * on a card that was never parsed: a malformed wrapper, or no price at
 * all, throws `unknown-op` rather than naming a currency it cannot vouch
 * for.
 */
export function cardPrice(card: Pick<RateCard, 'price'>): {
  currency: string
  expr: Expr
} {
  const raw: unknown = (card as { price?: unknown } | null)?.price
  const wrapper = currencyWrapper(raw)
  if (raw === undefined || wrapper === 'malformed') {
    throw new RateCardError(
      'unknown-op',
      `price is not an expression or { currency: [code, expr] }: ${JSON.stringify(raw)}`,
    )
  }
  return wrapper === null
    ? { currency: 'USD', expr: raw as Expr }
    : { currency: wrapper.currency, expr: wrapper.expr as Expr }
}

/** The ISO-4217 code a card's amounts are in: USD unless its price says. */
export function cardCurrency(card: Pick<RateCard, 'price'>): string {
  return cardPrice(card).currency
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const isCoreOp = (op: string): op is CoreOp =>
  (CORE_OPS as readonly string[]).includes(op)

/** `{var: 'image_size.width'}` walks dotted paths. */
function readVar(vars: Vars, path: string): unknown {
  let value: unknown = vars
  for (const key of path.split('.')) {
    if (!isRecord(value) || !(key in value)) return undefined
    value = value[key]
  }
  return value
}

/**
 * `==` is strict, unlike JSONLogic's loose `==`: a number against a string
 * (Kling's `duration` "5" is bound as 5) refuses instead of quietly taking
 * the wrong branch.
 */
function same(a: unknown, b: unknown): boolean {
  const kind = (v: unknown) =>
    typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean'
      ? typeof v
      : undefined
  if (kind(a) === undefined || kind(a) !== kind(b)) {
    throw new RateCardError(
      'not-comparable',
      `${JSON.stringify(a)} vs ${JSON.stringify(b)}`,
    )
  }
  return a === b
}

const truthy = (v: unknown): boolean =>
  Array.isArray(v) ? v.length > 0 : Boolean(v)

function lookup(
  tables: Record<string, Table>,
  table: string,
  path: string[],
): number | undefined {
  let node: number | Table | undefined = tables[table]
  for (const key of path) {
    node = typeof node === 'object' ? node[key] : undefined
  }
  return typeof node === 'number' ? node : undefined
}

function evalExpr(
  expr: Expr,
  vars: Vars,
  tables: Record<string, Table>,
): unknown {
  if (typeof expr !== 'object') return expr
  const ev = (e: Expr) => evalExpr(e, vars, tables)
  const num = (e: Expr): number => {
    const v = ev(e)
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new RateCardError(
        'not-a-number',
        `${JSON.stringify(e)} → ${JSON.stringify(v)}`,
      )
    }
    return v
  }

  if ('lookup' in expr) {
    const { table, keys, default: fallback } = expr.lookup
    const path = keys.map((k) => {
      const key = ev(k)
      if (typeof key === 'string') return key
      if (typeof key === 'number') return String(key)
      throw new RateCardError(
        'missing-key',
        `${table}: key ${JSON.stringify(key)}`,
      )
    })
    const hit = lookup(tables, table, path)
    if (hit !== undefined) return hit
    if (fallback !== undefined) return ev(fallback)
    throw new RateCardError('missing-key', `${table}[${path.join('][')}]`)
  }

  const keys = Object.keys(expr)
  const op = keys[0]
  if (keys.length !== 1 || op === undefined || !isCoreOp(op)) {
    throw new RateCardError('unknown-op', keys.join(','))
  }
  const raw = expr[op]
  const args: Expr[] = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]
  const arg = (i: number): Expr => {
    const e = args[i]
    if (e === undefined) {
      throw new RateCardError('unknown-op', `${op}: missing operand ${i}`)
    }
    return e
  }
  const name = (e: Expr): string => {
    if (typeof e !== 'string') {
      throw new RateCardError('unbound-var', JSON.stringify(e))
    }
    return e
  }

  switch (op) {
    case 'var': {
      const v = readVar(vars, name(arg(0)))
      if (v === undefined) throw new RateCardError('unbound-var', name(arg(0)))
      return v
    }
    case 'missing':
      return args.map(name).filter((n) => readVar(vars, n) === undefined)
    case '+':
      return args.reduce<number>((sum, e) => sum + num(e), 0)
    case '*':
      return args.reduce<number>((product, e) => product * num(e), 1)
    case '-':
      return args.length === 1 ? -num(arg(0)) : num(arg(0)) - num(arg(1))
    case '/':
      return num(arg(0)) / num(arg(1))
    case 'max':
      return Math.max(...args.map(num))
    case 'min':
      return Math.min(...args.map(num))
    case 'ceil':
      return Math.ceil(num(arg(0)))
    case 'floor':
      return Math.floor(num(arg(0)))
    case '==':
      return same(ev(arg(0)), ev(arg(1)))
    case '!=':
      return !same(ev(arg(0)), ev(arg(1)))
    case '<':
      return num(arg(0)) < num(arg(1))
    case '<=':
      return num(arg(0)) <= num(arg(1))
    case '>':
      return num(arg(0)) > num(arg(1))
    case '>=':
      return num(arg(0)) >= num(arg(1))
    case 'and': {
      let last: unknown = true
      for (const e of args) {
        last = ev(e)
        if (!truthy(last)) return last
      }
      return last
    }
    case 'or': {
      let last: unknown = false
      for (const e of args) {
        last = ev(e)
        if (truthy(last)) return last
      }
      return last
    }
    case 'if': {
      // [cond, then, cond, then, ..., else]
      for (let i = 0; i + 1 < args.length; i += 2) {
        if (truthy(ev(arg(i)))) return ev(arg(i + 1))
      }
      return args.length % 2 === 1 ? ev(arg(args.length - 1)) : null
    }
  }
}

const isNumeric = (v: unknown): v is number | string =>
  (typeof v === 'number' && Number.isFinite(v)) ||
  (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)))

/**
 * Bind every input from `vars` by param name, with defaults. Never applies
 * an `estimate`: a number input with one but no value throws `required`
 * here (see `priceDetailed`).
 */
export function bindInputs(card: Pick<RateCard, 'inputs'>, params: Vars): Vars {
  const vars: Vars = {}
  for (const [name, input] of Object.entries(card.inputs)) {
    const raw = params[input.param]
    const bad = (why: string, value?: unknown) =>
      new RateCardError(
        'bad-input',
        `${name} (${input.param}): ${why}${value === undefined ? '' : ` ${JSON.stringify(value)}`}`,
      )
    switch (input.kind) {
      case 'count':
        if (raw === undefined) vars[name] = 0
        else if (Array.isArray(raw)) vars[name] = raw.length
        else throw bad('expected a list, got', raw)
        break
      case 'number': {
        const value = raw ?? input.default
        if (value === undefined) throw bad('required')
        // Enum-typed durations arrive as strings ("5").
        if (!isNumeric(value)) throw bad('not a number:', value)
        vars[name] = Number(value)
        break
      }
      case 'boolean': {
        const value = raw ?? input.default
        if (value === undefined) throw bad('required')
        if (typeof value !== 'boolean')
          throw bad('expected a boolean, got', value)
        vars[name] = value
        break
      }
      case 'enum': {
        const value = raw ?? input.default
        if (value === undefined) throw bad('required')
        if (typeof value !== 'string' || !input.values.includes(value)) {
          throw bad(`not one of ${input.values.join('|')}:`, value)
        }
        vars[name] = value
        break
      }
      case 'dimensions': {
        const value = raw ?? input.default
        if (
          isRecord(value) &&
          isNumeric(value.width) &&
          isNumeric(value.height)
        ) {
          vars[name] = {
            width: Number(value.width),
            height: Number(value.height),
          }
          break
        }
        const pixels =
          typeof value === 'string' ? /^(\d+)x(\d+)$/.exec(value) : null
        if (pixels) {
          vars[name] = { width: Number(pixels[1]), height: Number(pixels[2]) }
          break
        }
        if (typeof value === 'string' && input.levels?.includes(value)) {
          vars[name] = { level: value }
          break
        }
        const preset =
          typeof value === 'string' ? input.presets?.[value] : undefined
        if (!preset) throw bad('unknown size:', value)
        vars[name] = { width: preset[0], height: preset[1] }
        break
      }
    }
  }
  return vars
}

/**
 * The amount for this call, as billed, in the card's currency
 * (`cardCurrency(card)`; USD unless the card says otherwise). Never add
 * or compare amounts from cards in different currencies. Request-bound
 * levers read `request`;
 * usage-bound levers read `usage`. A usage key on the request body, or a
 * request field in usage, is not read. Omit `usage` only when every
 * usage-bound input has a default (or the card has none); token cards that
 * require `input_tokens` / `output_tokens` throw `bad-input` without them.
 * Never estimates: an omitted input that carries an `estimate` throws
 * `required` like any other — call `priceDetailed` to get a labelled
 * estimate. Throws `RateCardError` rather than returning a number it
 * cannot stand behind.
 */
export function price(
  card: RateCard,
  request: Vars = {},
  usage: Vars = {},
): number {
  return evaluate(card, request, usage, false).amount
}

export interface PriceResult {
  /** The price, in `currency`. */
  amount: number
  /** ISO-4217 code `amount` is in. */
  currency: string
  /** `amount` again when `currency` is USD; absent for any other currency. */
  usd?: number
  /**
   * Params of inputs the caller omitted whose value came from the card's
   * published `estimate`. Empty means every input was supplied (or a plain
   * default), so `amount` is the price as billed.
   */
  estimated: string[]
}

/** Read each input's param from the request or usage object by bound. */
function collect(inputs: RateCard['inputs'], request: Vars, usage: Vars): Vars {
  const vars: Vars = {}
  for (const input of Object.values(inputs)) {
    const from = input.bound === 'usage' ? usage : request
    if (input.param in from) vars[input.param] = from[input.param]
  }
  return vars
}

/**
 * `price`, but an omitted input that carries an `estimate` is estimated
 * by it and named in `estimated`. An estimate that cannot be made for this
 * request throws `estimate-unavailable` naming the input to pass instead.
 */
export function priceDetailed(
  card: RateCard,
  request: Vars = {},
  usage: Vars = {},
): PriceResult {
  return evaluate(card, request, usage, true)
}

function evaluate(
  card: RateCard,
  request: Vars,
  usage: Vars,
  estimates: boolean,
): PriceResult {
  const given = collect(card.inputs, request, usage)
  const estimated: string[] = []
  const direct: RateCard['inputs'] = {}
  const pending: Array<[string, string, RateCardEstimate]> = []
  for (const [name, input] of Object.entries(card.inputs)) {
    if (
      estimates &&
      input.kind === 'number' &&
      input.estimate &&
      !(input.param in given)
    ) {
      pending.push([name, input.param, input.estimate])
      estimated.push(input.param)
    } else {
      direct[name] = input
    }
  }
  const vars = bindInputs({ inputs: direct }, given)
  for (const [name, param, estimate] of pending) {
    try {
      const own = bindInputs(estimate, collect(estimate.inputs, request, usage))
      const value = evalExpr(estimate.value, { ...vars, ...own }, card.tables)
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        throw new RateCardError(
          'bad-result',
          `estimate evaluated to ${JSON.stringify(value)}`,
        )
      }
      vars[name] = value
    } catch (error) {
      if (!(error instanceof RateCardError)) throw error
      throw new RateCardError(
        'estimate-unavailable',
        `${name} (${param}): not supplied, and cannot be estimated for this request: ${error.message}`,
      )
    }
  }
  const { currency, expr } = cardPrice(card)
  const amount = evalExpr(expr, vars, card.tables)
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    throw new RateCardError(
      'bad-result',
      `price evaluated to ${JSON.stringify(amount)}`,
    )
  }
  return {
    amount,
    currency,
    ...(currency === 'USD' && { usd: amount }),
    estimated,
  }
}

/** Relative tolerance when reproducing a source's worked example. */
const EXAMPLE_TOLERANCE = 0.01

export type ExampleResult = {
  example: RateCardExample
  ok: boolean
  usd?: number
  error?: string
}

/** Every worked example must reproduce within 1% or the card is rejected. */
export function verifyExamples(card: RateCard): ExampleResult[] {
  return card.examples.map((example) => {
    try {
      // Examples are a flat bag; each lever is read from request or usage
      // by bound, so the same dict in both slots is correct.
      const usd = price(card, example.params, example.params)
      const ok = Math.abs(usd - example.usd) <= example.usd * EXAMPLE_TOLERANCE
      return ok
        ? { example, ok, usd }
        : { example, ok, usd, error: `expected ${example.usd}, got ${usd}` }
    } catch (error) {
      const message =
        error instanceof RateCardError
          ? `${error.code}: ${error.message}`
          : String(error)
      return { example, ok: false, error: message }
    }
  })
}
