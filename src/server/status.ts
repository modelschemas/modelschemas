import { and, count, eq, isNull, sql } from 'drizzle-orm'

import type { Db } from '#/db/index.ts'
import { endpoints, models, providers, schemaVersions } from '#/db/schema.ts'
import { FACT_KEYS, buildReport, scoredFacts } from '#/lib/completeness.ts'
import type { FactKey, Ledger, ModelRow } from '#/lib/completeness.ts'
import { swr } from '#/server/cache.ts'
import type { SwrDeps } from '#/server/cache.ts'
import { readIngestRecords } from '#/server/ingest/docs-failing.ts'
import type {
  DocsFailing,
  PriceClearsRefused,
} from '#/server/ingest/docs-failing.ts'
import { providerRegistry } from '#/server/providers/index.ts'
import { servePricing } from '#/server/rate-card.ts'
import { resolveSchemaEndpointId } from '#/server/schema-binding.ts'
import { sourceSilentLedger } from '#/server/source-silent.ts'

/**
 * The gap-report score (`#/lib/completeness.ts`) over the provider's live
 * chat models: `filled / needed`, the same number `bun run gap:report`
 * prints.
 */
export interface Completeness {
  /**
   * 0 to 1, or null when the provider has no live chat models and so
   * nothing to score. (The CLI prints 0 there so its loop keeps going.)
   */
  score: number | null
  /** Live chat models scored. */
  chat: number
  /** Facts carried, summed over those models; `silent` facts left out. */
  filled: number
  /** Facts that apply, summed over those models; `silent` facts left out. */
  needed: number
  /** Facts the provider does not publish (`docs/source-silent`). */
  silent: Array<FactKey>
}

export interface ProviderStatus {
  id: string
  displayName: string
  /** `pending` = registered in code but not yet synced into the DB. */
  status: 'active' | 'degraded' | 'disabled' | 'pending'
  lastPolledAt: number | null
  lastSyncedAt: number | null
  /**
   * Present while the provider's docs pages fail to load: polls go on and
   * rows keep their stored docs-derived facts. Does not change `status`.
   */
  docsFailing?: DocsFailing
  /**
   * Present while polls refuse a mass price clear: the stored prices stay.
   * Does not change `status`.
   */
  priceClearsRefused?: PriceClearsRefused
  completeness: Completeness
  /** Model tallies count live rows: what `GET /v1/models` lists by default. */
  counts: {
    models: number
    /** Models with a stored rate card. */
    priced: number
    /** Models with stored reasoning metadata. */
    reasoning: number
    /** Models whose activity is `chat`. */
    chat: number
    /** Models no longer listed upstream; in none of the tallies above. */
    deprecated: number
    endpoints: number
    schemas: number
  }
}

export interface ServiceStatus {
  service: 'modelschemas'
  time: number
  providers: Array<ProviderStatus>
}

/** A tally of live rows, optionally only those matching `where`. */
const live = (where = sql`1`) =>
  sql<number>`count(case when ${models.deprecatedAt} is null and ${where} then 1 end)`

/**
 * Seconds a cached score is served before a background rescore. Scoring
 * reads every live chat row's JSON facts (about 2 MB on the full catalog),
 * too much for each home-page hit; a poll moves the score at most every
 * 15 minutes.
 */
const COMPLETENESS_STALE_TIME = 300

/**
 * Completeness of every provider with live chat rows. One query, only the
 * columns the score reads, each row shaped as `GET /v1/models?pricing=1`
 * serves it (`toApiModel`) so this and the CLI score the same thing.
 */
async function scoreCompleteness(
  db: Db,
  ledger: Ledger,
): Promise<Record<string, Completeness>> {
  const rows = await db
    .select({
      providerId: models.providerId,
      rawId: models.rawId,
      activity: models.activity,
      contextWindow: models.contextWindow,
      maxOutput: models.maxOutput,
      modalities: models.modalities,
      pricing: models.pricing,
      capabilities: models.capabilities,
      reasoning: models.reasoning,
      requestMap: models.requestMap,
      schemaEndpointId: models.schemaEndpointId,
    })
    .from(models)
    .where(and(eq(models.activity, 'chat'), isNull(models.deprecatedAt)))
  const report = buildReport(
    rows.map(
      (row): ModelRow => ({
        provider: row.providerId,
        activity: row.activity,
        contextWindow: row.contextWindow,
        maxOutput: row.maxOutput,
        // JSON columns: the scorer checks what it reads of each.
        modalities: row.modalities as ModelRow['modalities'],
        pricing: servePricing(row.pricing, 'full') as ModelRow['pricing'],
        capabilities: row.capabilities,
        reasoning: row.reasoning as ModelRow['reasoning'],
        requestMap: row.requestMap,
        schemaEndpointId: resolveSchemaEndpointId(row),
      }),
    ),
    ledger,
  )
  return Object.fromEntries(
    report.providers.map((provider) => {
      const { have, need } = scoredFacts(provider)
      return [
        provider.provider,
        {
          score: provider.score,
          chat: provider.chat,
          filled: have,
          needed: need,
          silent: provider.silent,
        },
      ]
    }),
  )
}

export interface StatusOptions {
  /** Defaults to the bundled `docs/source-silent` ledger. */
  ledger?: Ledger
  /** Serve completeness from the SWR cache; without it, score inline. */
  cache?: SwrDeps
}

/**
 * Public per-provider sync status + row counts (GET /v1/status).
 *
 * The provider REGISTRY (code) is the source of truth for which providers
 * exist; the DB carries runtime state. Registered providers whose first
 * sync hasn't landed yet still appear — as `pending` with zero counts — so
 * the listing is always the full roster, for humans and agents alike.
 */
export async function getServiceStatus(
  db: Db,
  now = Math.floor(Date.now() / 1000),
  { ledger = sourceSilentLedger, cache }: StatusOptions = {},
): Promise<ServiceStatus> {
  const score = () => scoreCompleteness(db, ledger)
  const [
    providerRows,
    records,
    scored,
    modelCounts,
    endpointCounts,
    schemaCounts,
  ] = await Promise.all([
    db.select().from(providers),
    // One statement for every provider's docs-failing / refused-clears row.
    readIngestRecords(db),
    cache
      ? swr(cache, 'status:completeness', score, {
          staleTime: COMPLETENESS_STALE_TIME,
        }).then((result) => result.value)
      : score(),
    // One pass yields every model tally. Deprecated rows are counted apart:
    // the catalog hides them, and a provider's count must match its list.
    db
      .select({
        providerId: models.providerId,
        models: live(),
        priced: live(sql`${models.pricing} is not null`),
        reasoning: live(sql`${models.reasoning} is not null`),
        chat: live(sql`${models.activity} = 'chat'`),
        deprecated: count(models.deprecatedAt),
      })
      .from(models)
      .groupBy(models.providerId),
    db
      .select({ providerId: endpoints.providerId, n: count() })
      .from(endpoints)
      .groupBy(endpoints.providerId),
    // Current (non-superseded) schema versions per provider.
    db
      .select({ providerId: endpoints.providerId, n: count() })
      .from(schemaVersions)
      .innerJoin(endpoints, eq(schemaVersions.endpointId, endpoints.id))
      .where(isNull(schemaVersions.supersededAt))
      .groupBy(endpoints.providerId),
  ])

  const toMap = (rows: Array<{ providerId: string; n: number }>) =>
    new Map(rows.map((r) => [r.providerId, r.n]))
  const modelsBy = new Map(modelCounts.map((r) => [r.providerId, r]))
  const endpointsBy = toMap(endpointCounts)
  const schemasBy = toMap(schemaCounts)
  // No live chat rows: nothing to score, which is not a score of zero. The
  // live count decides, so a cached score never outlives its last chat row.
  const completeness = (providerId: string): Completeness =>
    (modelsBy.get(providerId)?.chat ? scored[providerId] : undefined) ?? {
      score: null,
      chat: 0,
      filled: 0,
      needed: 0,
      silent: FACT_KEYS.filter((key) => ledger.get(providerId)?.has(key)),
    }

  const byId = new Map<string, ProviderStatus>()
  for (const p of providerRows) {
    byId.set(p.id, {
      id: p.id,
      displayName: p.displayName,
      status: p.status,
      lastPolledAt: p.lastPolledAt,
      lastSyncedAt: p.lastSyncedAt,
      ...records.get(p.id),
      completeness: completeness(p.id),
      counts: {
        models: modelsBy.get(p.id)?.models ?? 0,
        priced: modelsBy.get(p.id)?.priced ?? 0,
        reasoning: modelsBy.get(p.id)?.reasoning ?? 0,
        chat: modelsBy.get(p.id)?.chat ?? 0,
        deprecated: modelsBy.get(p.id)?.deprecated ?? 0,
        endpoints: endpointsBy.get(p.id) ?? 0,
        schemas: schemasBy.get(p.id) ?? 0,
      },
    })
  }
  // Registered but not yet in the DB (fresh adapter, seed not run).
  for (const config of providerRegistry) {
    if (byId.has(config.id)) continue
    byId.set(config.id, {
      id: config.id,
      displayName: config.displayName,
      status: 'pending',
      lastPolledAt: null,
      lastSyncedAt: null,
      completeness: completeness(config.id),
      counts: {
        models: 0,
        priced: 0,
        reasoning: 0,
        chat: 0,
        deprecated: 0,
        endpoints: 0,
        schemas: 0,
      },
    })
  }

  return {
    service: 'modelschemas',
    time: now,
    providers: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)),
  }
}
