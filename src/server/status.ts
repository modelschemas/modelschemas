import { count, eq, isNull, sql } from 'drizzle-orm'

import type { Db } from '#/db/index.ts'
import { endpoints, models, providers, schemaVersions } from '#/db/schema.ts'
import { readIngestRecords } from '#/server/ingest/docs-failing.ts'
import type {
  DocsFailing,
  PriceClearsRefused,
} from '#/server/ingest/docs-failing.ts'
import { providerRegistry } from '#/server/providers/index.ts'

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
  counts: {
    models: number
    /** Models with a stored rate card. */
    priced: number
    /** Models with stored reasoning metadata. */
    reasoning: number
    /** Models whose activity is `chat` — the reasoning score's denominator. */
    chat: number
    endpoints: number
    schemas: number
  }
}

export interface ServiceStatus {
  service: 'modelschemas'
  time: number
  providers: Array<ProviderStatus>
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
): Promise<ServiceStatus> {
  const [providerRows, records, modelCounts, endpointCounts, schemaCounts] =
    await Promise.all([
      db.select().from(providers),
      // One statement for every provider's docs-failing / refused-clears row.
      readIngestRecords(db),
      // count(column) skips NULLs, so one pass yields every model tally.
      db
        .select({
          providerId: models.providerId,
          models: count(),
          priced: count(models.pricing),
          reasoning: count(models.reasoning),
          chat: sql<number>`count(case when ${models.activity} = 'chat' then 1 end)`,
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

  const byId = new Map<string, ProviderStatus>()
  for (const p of providerRows) {
    byId.set(p.id, {
      id: p.id,
      displayName: p.displayName,
      status: p.status,
      lastPolledAt: p.lastPolledAt,
      lastSyncedAt: p.lastSyncedAt,
      ...records.get(p.id),
      counts: {
        models: modelsBy.get(p.id)?.models ?? 0,
        priced: modelsBy.get(p.id)?.priced ?? 0,
        reasoning: modelsBy.get(p.id)?.reasoning ?? 0,
        chat: modelsBy.get(p.id)?.chat ?? 0,
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
      counts: {
        models: 0,
        priced: 0,
        reasoning: 0,
        chat: 0,
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
