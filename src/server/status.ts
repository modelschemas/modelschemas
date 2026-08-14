import { count, eq, isNull } from 'drizzle-orm'

import type { Db } from '#/db/index.ts'
import { endpoints, models, providers, schemaVersions } from '#/db/schema.ts'
import { providerRegistry } from '#/server/providers/index.ts'

export interface ProviderStatus {
  id: string
  displayName: string
  /** `pending` = registered in code but not yet synced into the DB. */
  status: 'active' | 'degraded' | 'disabled' | 'pending'
  lastPolledAt: number | null
  lastSyncedAt: number | null
  counts: { models: number; endpoints: number; schemas: number }
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
  const [providerRows, modelCounts, endpointCounts, schemaCounts] =
    await Promise.all([
      db.select().from(providers),
      db
        .select({ providerId: models.providerId, n: count() })
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
  const modelsBy = toMap(modelCounts)
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
      counts: {
        models: modelsBy.get(p.id) ?? 0,
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
      counts: { models: 0, endpoints: 0, schemas: 0 },
    })
  }

  return {
    service: 'modelschemas',
    time: now,
    providers: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)),
  }
}
