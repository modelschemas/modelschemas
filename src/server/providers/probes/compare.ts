import type { ProbeExpect } from './types.ts'

/** Null when the live call still matches the record. */
export function observationMatches(
  expect: ProbeExpect,
  actual: { status: number; payloads: Array<unknown> },
): string | null {
  if (actual.status !== expect.status) {
    return `status ${actual.status}, expected ${expect.status}`
  }
  if (actual.payloads.length === 0) return 'response had no JSON object'
  for (const payload of actual.payloads) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return 'response JSON was not an object'
    }
    const missing = expect.jsonKeys.filter(
      (key) => !Object.keys(payload).includes(key),
    )
    if (missing.length > 0) return `missing ${missing.join(', ')}`
  }
  return null
}

/** Replace one record's verifiedAt. Throws when that id is not in the file. */
export function bumpVerifiedAt(
  source: string,
  id: string,
  date: string,
): string {
  const pattern = new RegExp(
    `(id: '${id}'[\\s\\S]*?verifiedAt: ')\\d{4}-\\d{2}-\\d{2}(')`,
  )
  if (!pattern.test(source)) throw new Error(`probe: no verifiedAt for ${id}`)
  return source.replace(pattern, `$1${date}$2`)
}
