/**
 * Whether two model snapshots are the same fact.
 *
 * A source hash, an extract time, object key order, the operand order of
 * `+`, and the order of an input's `values` are not facts. Everything else
 * in the snapshot is, including `expiresAt` and a rate.
 */
import { stableStringify } from '#/server/kv.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `Array.isArray` types the elements as `any`. Copy them as `unknown`. */
function copyArray(value: unknown): Array<unknown> | null {
  if (!Array.isArray(value)) return null
  return (value as Array<unknown>).slice()
}

function compareValue(a: unknown, b: unknown): number {
  const as = typeof a === 'string' ? a : stableStringify(a)
  const bs = typeof b === 'string' ? b : stableStringify(b)
  return as < bs ? -1 : as > bs ? 1 : 0
}

/** Drop the clock and the text hash. The URL and `expiresAt` stay. */
function stripSource(source: unknown): void {
  if (!isRecord(source)) return
  delete source.hash
  delete source.extractedAt
}

function normalizeInputs(inputs: unknown): void {
  if (!isRecord(inputs)) return
  for (const input of Object.values(inputs)) {
    if (!isRecord(input)) continue
    const values = copyArray(input.values)
    if (values) input.values = values.sort(compareValue)
    if (isRecord(input.estimate)) {
      stripSource(input.estimate.source)
      normalizeInputs(input.estimate.inputs)
    }
  }
}

/** Sort every `+` after its operands are themselves canonical. */
function sortPlus(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortPlus)
  if (!isRecord(value)) return value
  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    const sorted = sortPlus(child)
    const operands = key === '+' ? copyArray(sorted) : null
    out[key] = operands ? operands.sort(compareValue) : sorted
  }
  return out
}

function normalizePricing(pricing: unknown): void {
  if (!isRecord(pricing)) return
  stripSource(pricing.source)
  normalizeInputs(pricing.inputs)
  if ('price' in pricing) pricing.price = sortPlus(pricing.price)
}

/** Snapshot reduced to facts. The argument is not mutated. */
function facts(snapshot: unknown): unknown {
  const copy: unknown = structuredClone(snapshot)
  if (isRecord(copy)) normalizePricing(copy.pricing)
  return copy
}

function diff(a: unknown, b: unknown, path: string, out: Array<string>): void {
  if (stableStringify(a) === stableStringify(b)) return
  if (isRecord(a) && isRecord(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    for (const key of [...keys].sort()) {
      diff(a[key], b[key], path === '' ? key : `${path}.${key}`, out)
    }
    return
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const length = Math.max(a.length, b.length)
    for (let index = 0; index < length; index++) {
      diff(a[index], b[index], `${path}.${String(index)}`, out)
    }
    return
  }
  if (path !== '') out.push(path)
}

/** Field paths that differ between the fact forms. Sorted. Empty when equal. */
export function changedFactPaths(
  before: unknown,
  after: unknown,
): Array<string> {
  const paths: Array<string> = []
  diff(facts(before), facts(after), '', paths)
  paths.sort()
  return paths
}

/**
 * The `model.updated` payload. Refuses an empty `changed` list: an event
 * with nothing to report is not written.
 */
export function modelUpdatedPayload(
  before: unknown,
  after: unknown,
  changed: ReadonlyArray<string>,
): { before: unknown; after: unknown; changed: Array<string> } {
  if (changed.length === 0) {
    throw new Error('model.updated requires a changed fact')
  }
  return { before, after, changed: [...changed] }
}
