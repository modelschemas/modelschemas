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
  return Object.fromEntries(
    Object.entries(card.inputs).map(([name, input]) => [
      name,
      seedField(input, best?.params[input.param]),
    ]),
  )
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
    if (value === undefined) continue
    const slot = input.bound === 'usage' ? usage : request
    // `count` prices a list's length; the items themselves are never read.
    slot[input.param] =
      input.kind === 'count'
        ? Array.from(
            { length: Math.max(0, Math.floor(Number(value)) || 0) },
            () => '',
          )
        : value
  }
  return { request, usage }
}
