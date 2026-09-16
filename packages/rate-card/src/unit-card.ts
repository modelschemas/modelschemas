/**
 * Per-unit rate sheet → card. The shape behind everything a host does not
 * bill by token: a rate per second of video, per minute of audio, per
 * character, per image — optionally looked up by request fields that change
 * it (size, quality, resolution).
 *
 * `price` is `quantity × rate[key…]`, the same shape the hand-written media
 * fixtures use. A quantity that is a real request field is request-bound and
 * priced from the request alone; one the request cannot state (how long the
 * uploaded audio is) is usage-bound and supplied by the caller.
 */
import type { Expr, RateCard, Table } from './rate-card.schema.ts'

export interface UnitQuantity {
  param: string
  bound?: 'request' | 'usage'
  /** Omitted means the caller must supply it rather than be guessed for. */
  default?: number
}

export interface UnitKey {
  param: string
  values: Array<string>
  bound?: 'request' | 'usage'
  default?: string
}

export interface UnitCardSpec {
  /** Units billed. Omitted prices one unit (a flat per-request rate). */
  quantity?: UnitQuantity
  /** Enum dimensions the rate is looked up by, outermost first. */
  keys?: Array<UnitKey>
  /** A flat rate, or a table nested in `keys` order. */
  rates: number | Table
}

/** Every leaf of a rate table is a usable, non-zero price. */
function priced(rates: number | Table, depth: number): boolean {
  if (typeof rates === 'number') {
    return depth === 0 && Number.isFinite(rates) && rates > 0
  }
  const entries = Object.values(rates)
  return (
    depth > 0 &&
    entries.length > 0 &&
    entries.every((entry) => priced(entry, depth - 1))
  )
}

/** Every combination the key values name has a rate. */
function covered(rates: number | Table, keys: Array<UnitKey>): boolean {
  const [key, ...rest] = keys
  if (!key) return typeof rates === 'number'
  if (typeof rates === 'number') return false
  return key.values.every((value) => {
    const next = rates[value]
    return next !== undefined && covered(next, rest)
  })
}

/**
 * `null` when the sheet prices nothing it can stand behind: a zero or
 * unusable rate, or a key value the table has no rate for.
 */
export function compileUnitCard(
  spec: UnitCardSpec,
  source: RateCard['source'],
): RateCard | null {
  const keys = spec.keys ?? []
  if (!priced(spec.rates, keys.length)) return null
  if (!covered(spec.rates, keys)) return null

  const inputs: RateCard['inputs'] = {}
  if (spec.quantity) {
    inputs[spec.quantity.param] = {
      param: spec.quantity.param,
      bound: spec.quantity.bound ?? 'request',
      kind: 'number',
      ...(spec.quantity.default !== undefined && {
        default: spec.quantity.default,
      }),
    }
  }
  for (const key of keys) {
    if (key.default !== undefined && !key.values.includes(key.default)) {
      return null
    }
    inputs[key.param] = {
      param: key.param,
      bound: key.bound ?? 'request',
      kind: 'enum',
      values: key.values,
      ...(key.default !== undefined && { default: key.default }),
    }
  }

  const rate: Expr =
    typeof spec.rates === 'number'
      ? spec.rates
      : {
          lookup: {
            table: 'rate',
            keys: keys.map((key) => ({ var: key.param })),
          },
        }

  return {
    inputs,
    tables: typeof spec.rates === 'number' ? {} : { rate: spec.rates },
    price: spec.quantity ? { '*': [{ var: spec.quantity.param }, rate] } : rate,
    examples: [],
    source,
  }
}
