/** Read-time evidence for provider facts absent from the published sources. */
import { parseLedger } from '#/lib/completeness.ts'
import type { FactKey } from '#/lib/completeness.ts'
import type { FactSource, ModelFactSources } from './providers/types.ts'

export interface SourceSilentEvidence {
  derivation: 'source-silent'
  sourceUrl?: string
  /** The date recorded by the ledger author, never a request timestamp. */
  checkedAt?: string
}

export type ApiFactSource = FactSource | SourceSilentEvidence

/** Stored ingest provenance remains unchanged; silence is added only on reads. */
export type ApiModelFactSources = Omit<
  ModelFactSources,
  | 'contextWindow'
  | 'maxOutput'
  | 'modalities'
  | 'pricing'
  | 'reasoning'
  | 'requestMap'
  | 'capabilities'
  | 'serverTools'
> & {
  contextWindow?: ApiFactSource
  maxOutput?: ApiFactSource
  modalities?: ApiFactSource
  pricing?: ApiFactSource
  reasoning?: ApiFactSource
  requestMap?: ApiFactSource
  capabilities?: Record<string, FactSource> | SourceSilentEvidence
  serverTools?: Record<string, FactSource> | SourceSilentEvidence
  schemaEndpointId?: SourceSilentEvidence
  cacheRead?: SourceSilentEvidence
  efforts?: SourceSilentEvidence
}

export type SourceSilentEvidenceLedger = Map<
  string,
  Map<FactKey, SourceSilentEvidence>
>

/** Same entry grammar as scoring; metadata is copied only when actually recorded. */
export function parseSourceSilentEvidence(
  markdown: string,
): SourceSilentEvidenceLedger {
  const ledger = parseLedger(markdown)
  const evidence: SourceSilentEvidenceLedger = new Map()
  for (const line of markdown.split('\n')) {
    const match = /^- `?([\w.-]+)`?: `?(\w+)`?/.exec(line)
    const provider = match?.[1]
    const key = match?.[2] as FactKey | undefined
    if (!provider || !key || !ledger.get(provider)?.has(key)) continue
    const url = /https?:\/\/[^\s,`)]+/.exec(line)?.[0]
    const date = /\bchecked\s+([^\s,`);.]+)/.exec(line)?.[1]
    if (date) {
      const time = Date.parse(`${date}T00:00:00Z`)
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        !Number.isFinite(time) ||
        new Date(time).toISOString().slice(0, 10) !== date
      ) {
        throw new Error(`source-silent ledger: invalid checked date ${date}`)
      }
    }
    const source: SourceSilentEvidence = {
      derivation: 'source-silent',
      ...(url ? { sourceUrl: url } : {}),
      ...(date ? { checkedAt: date } : {}),
    }
    const entries =
      evidence.get(provider) ?? new Map<FactKey, SourceSilentEvidence>()
    if (entries.has(key))
      throw new Error(`source-silent ledger: duplicate ${provider}: ${key}`)
    entries.set(key, source)
    evidence.set(provider, entries)
  }
  return evidence
}

interface SilentModelFacts {
  providerId: string
  activity: string | null
  contextWindow: unknown
  maxOutput: unknown
  modalities: unknown
  pricing: unknown
  capabilities: unknown
  reasoning: unknown
  requestMap: unknown
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function missingCacheRead(pricing: unknown): boolean {
  if (
    !record(pricing) ||
    !record(pricing.tables) ||
    !record(pricing.tables.rate)
  )
    return true
  return !Object.values(pricing.tables.rate).some(
    (tier) =>
      record(tier) &&
      (tier.cache_read_tokens != null || tier.input_cache_read != null),
  )
}

/** Never alter model values, populated-fact provenance, or resolved identity evidence. */
export function withSourceSilentEvidence(
  row: SilentModelFacts,
  schemaEndpointId: string | null,
  stored: ModelFactSources | null,
  ledger: SourceSilentEvidenceLedger,
): ApiModelFactSources | null {
  // The source-silent ledger describes the chat facts scored by completeness.
  const entries =
    row.activity === 'chat' ? ledger.get(row.providerId) : undefined
  if (!entries) return stored
  const sources: ApiModelFactSources = { ...stored }
  for (const [key, evidence] of entries) {
    switch (key) {
      case 'contextWindow':
      case 'maxOutput':
      case 'modalities':
      case 'capabilities':
      case 'reasoning':
      case 'requestMap':
        if (row[key] == null) sources[key] = evidence
        break
      case 'priced':
        if (row.pricing == null) sources.pricing = evidence
        break
      case 'endpoint':
        if (schemaEndpointId === null) sources.schemaEndpointId = evidence
        break
      case 'cacheRead':
        if (missingCacheRead(row.pricing)) sources.cacheRead = evidence
        break
      case 'efforts':
        if (
          record(row.reasoning) &&
          (row.reasoning.mode === 'effort' ||
            row.reasoning.mode === 'adaptive') &&
          (!Array.isArray(row.reasoning.efforts) ||
            row.reasoning.efforts.length === 0)
        )
          sources.efforts = evidence
        break
    }
  }
  return Object.keys(sources).length ? sources : stored
}
