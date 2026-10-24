/**
 * /changes rows: what a `model.updated` event changed, as short text.
 * Reads the payload's `changed` fact paths against its before/after
 * snapshots. An event written before `changed` existed shows nothing.
 */
export interface ChangeDiff {
  path: string
  before: string
  after: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function at(root: unknown, path: string): unknown {
  let value = root
  for (const key of path.split('.')) {
    if (Array.isArray(value)) value = (value as Array<unknown>)[Number(key)]
    else if (isRecord(value)) value = value[key]
    else return undefined
  }
  return value
}

function show(value: unknown, path: string): string {
  if (value === undefined) return '—'
  if (value === null) return 'null'
  // Rates are stored per token; a reader compares them per million.
  if (typeof value === 'number' && path.startsWith('pricing.tables.')) {
    return `$${String(Number((value * 1e6).toPrecision(6)))}/M`
  }
  if (typeof value === 'object') return path === 'pricing' ? 'card' : '{…}'
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return String(value)
  }
  return '{…}'
}

export function changeDiffs(payload: unknown): Array<ChangeDiff> {
  if (!isRecord(payload) || !Array.isArray(payload.changed)) return []
  return (payload.changed as Array<unknown>)
    .filter((path): path is string => typeof path === 'string')
    .map((path) => ({
      path,
      before: show(at(payload.before, path), path),
      after: show(at(payload.after, path), path),
    }))
}
