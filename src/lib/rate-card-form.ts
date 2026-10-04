/**
 * Form state for the interactive rate card: one field per card input,
 * seeded from the card's worked examples, turned back into the
 * `{ request, usage }` pair `POST /v1/estimate` prices.
 */
import type { RateCard } from '@modelschemas/rate-card'

type CardInput = RateCard['inputs'][string]

/** Numbers stay strings while being edited; the estimator reports bad ones. */
export type FieldValue = string | boolean | { width: string; height: string }

export function formatUsd(n: number): string {
  if (Number.isInteger(n)) return `$${String(n)}`
  const fixed = n >= 0.01 ? n.toFixed(4) : n.toFixed(6)
  return `$${fixed.replace(/0+$/, '').replace(/\.$/, '')}`
}

const TOKEN_DEFAULT = 1_000_000

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function seedField(input: CardInput, example: unknown): FieldValue {
  switch (input.kind) {
    case 'number': {
      // A published estimate runs only when this value is omitted.
      if (input.estimate && example === undefined) return ''
      const value =
        typeof example === 'number' || typeof example === 'string'
          ? example
          : (input.default ??
            (input.param.endsWith('_tokens') ? TOKEN_DEFAULT : 1))
      return String(value)
    }
    case 'count':
      return String(Array.isArray(example) ? example.length : 1)
    case 'boolean':
      return typeof example === 'boolean' ? example : (input.default ?? false)
    case 'enum':
      if (
        example === undefined &&
        input.param === 'resolution' &&
        input.default === undefined &&
        input.values.includes('720p')
      ) {
        return '720p'
      }
      return typeof example === 'string' && input.values.includes(example)
        ? example
        : (input.default ?? input.values[0] ?? '')
    case 'dimensions': {
      if (isRecord(example)) {
        return { width: String(example.width), height: String(example.height) }
      }
      const presets = input.presets ?? {}
      const preset =
        (typeof example === 'string' ? presets[example] : undefined) ??
        (input.default !== undefined ? presets[input.default] : undefined) ??
        Object.values(presets).at(0) ??
        ([1024, 1024] as const)
      return { width: String(preset[0]), height: String(preset[1]) }
    }
  }
}

/**
 * Worked video examples on provider pages are 16:9 and 5 seconds. Those
 * are form seeds only; omitting them on the API still refuses.
 */
function seedEstimateField(input: CardInput, example: unknown): FieldValue {
  if (example === undefined && input.kind === 'enum') {
    if (input.values.includes('16:9')) return '16:9'
  }
  if (
    example === undefined &&
    input.kind === 'number' &&
    input.param === 'duration' &&
    input.default === undefined
  ) {
    return '5'
  }
  return seedField(input, example)
}

export interface FormField {
  name: string
  input: CardInput
  /** This field feeds an estimate of `estimates`, and is not itself billed. */
  estimates?: string
}

/**
 * Fields the calculator draws. Estimate inputs (duration, ratio) sit in
 * front of the number they fill.
 */
export function formFields(inputs: RateCard['inputs']): FormField[] {
  const fields: FormField[] = []
  for (const [name, input] of Object.entries(inputs)) {
    if (input.kind === 'number' && input.estimate) {
      for (const [ename, einput] of Object.entries(input.estimate.inputs)) {
        fields.push({ name: ename, input: einput, estimates: input.param })
      }
    }
    fields.push({ name, input })
  }
  return fields
}

/** Seed every input from the example that sets the most of them. */
export function seedValues(
  card: Pick<RateCard, 'inputs' | 'examples'>,
): Record<string, FieldValue> {
  const params = Object.values(card.inputs).map((input) => input.param)
  const covered = (example: RateCard['examples'][number]) =>
    params.filter((param) => param in example.params).length
  const best = card.examples.reduce<RateCard['examples'][number] | undefined>(
    (top, example) =>
      top === undefined || covered(example) > covered(top) ? example : top,
    undefined,
  )
  const values: Record<string, FieldValue> = Object.fromEntries(
    Object.entries(card.inputs).map(([name, input]) => [
      name,
      seedField(input, best?.params[input.param]),
    ]),
  )
  for (const input of Object.values(card.inputs)) {
    if (input.kind !== 'number' || !input.estimate) continue
    for (const [name, einput] of Object.entries(input.estimate.inputs)) {
      values[name] = seedEstimateField(einput, best?.params[einput.param])
    }
  }
  return values
}

// ponytail: lists past this are sent raw and refused, not built in memory.
const MAX_COUNT = 1000

/**
 * `count` prices a list's length; the items are never read. Anything but a
 * whole number up to MAX_COUNT goes through as-is so the estimator refuses
 * it ("expected a list") instead of pricing a guessed length.
 */
function countList(value: FieldValue): unknown {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return value
  const length = Number(value)
  return length <= MAX_COUNT ? Array.from({ length }, () => '') : value
}

function assign(
  slot: Record<string, unknown>,
  input: CardInput,
  value: FieldValue,
): void {
  // Blank means omitted, so a published estimate can run.
  if (input.kind === 'number' && value === '') return
  slot[input.param] = input.kind === 'count' ? countList(value) : value
}

/** Split field values into the estimate body's request/usage slots. */
export function toEstimateParts(
  inputs: RateCard['inputs'],
  values: Record<string, FieldValue>,
): { request: Record<string, unknown>; usage: Record<string, unknown> } {
  const request: Record<string, unknown> = {}
  const usage: Record<string, unknown> = {}
  for (const [name, input] of Object.entries(inputs)) {
    const value = values[name]
    if (value !== undefined) {
      assign(input.bound === 'usage' ? usage : request, input, value)
    }
    if (input.kind !== 'number' || !input.estimate) continue
    for (const [ename, einput] of Object.entries(input.estimate.inputs)) {
      const estimated = values[ename]
      if (estimated === undefined) continue
      assign(einput.bound === 'usage' ? usage : request, einput, estimated)
    }
  }
  return { request, usage }
}
