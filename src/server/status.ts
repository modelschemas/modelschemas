import { count, eq, isNull } from 'drizzle-orm'

import type { Db } from '#/db/index.ts'
import { endpoints, models, providers, schemaVersions } from '#/db/schema.ts'

export interface ProviderStatus {
  id: string
  displayName: string
  status: 'active' | 'degraded' | 'disabled'
  lastPolledAt: number | null
  lastSyncedAt: number | null
  counts: { models: number; endpoints: number; schemas: number }
}

export interface ServiceStatus {
  service: 'modelschemas'
  time: number
  providers: Array<ProviderStatus>
}

/** Public per-provider sync status + row counts (GET /v1/status). */
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

  return {
    service: 'modelschemas',
    time: now,
    providers: providerRows
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((p) => ({
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
      })),
  }
}
