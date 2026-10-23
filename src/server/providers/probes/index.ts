import type { FactSource } from '../types.ts'
import {
  OPENCODE_GO_PROBE_SOURCE,
  records as opencodeGo,
} from './opencode-go.ts'
import { probeIsStale } from './types.ts'
import type { ProbeRecord } from './types.ts'

const SOURCE: Record<string, string> = {
  'opencode-go': OPENCODE_GO_PROBE_SOURCE,
}

/** Every committed probe. Add a provider by importing its module here. */
export const probeRecords: Array<ProbeRecord> = [...opencodeGo]

export function probesFor(provider: string): Array<ProbeRecord> {
  return probeRecords.filter((record) => record.provider === provider)
}

function namesModel(route: string, model: string): boolean {
  return route.split('/').some((segment) => segment.split(':')[0] === model)
}

/**
 * The route a catalog row may bind. `:generateContent` wins when that
 * model has several records. Another model's record never matches.
 */
export function probedRoute(provider: string, model: string): string | null {
  const matches = probesFor(provider).filter(
    (record) => record.model === model && namesModel(record.route, model),
  )
  const primary =
    matches.find((record) => record.route.endsWith(':generateContent')) ??
    (matches.length === 1 ? matches[0] : undefined)
  return primary?.route ?? null
}

export function probeFactSource(
  provider: string,
  model: string,
  route: string,
): FactSource | null {
  const record = probesFor(provider).find(
    (item) => item.model === model && item.route === route,
  )
  if (!record) return null
  const source = SOURCE[provider]
  if (!source) return null
  return {
    derivation: 'probe-verified',
    verifiedAt: record.verifiedAt,
    sourceUrl: `${source}#${record.id}`,
  }
}

/** Records whose `verifiedAt` is older than `PROBE_STALE_DAYS`. */
export function staleProbeCount(provider: string, now = new Date()): number {
  return probesFor(provider).filter((record) =>
    probeIsStale(record.verifiedAt, now),
  ).length
}
