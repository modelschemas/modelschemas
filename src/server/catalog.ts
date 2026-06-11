/**
 * Catalog queries (PLAN.md task 4.2): providers, cross-provider model
 * catalog with filters, and single-model detail. Route handlers stay thin —
 * these functions are exercised directly by worker tests.
 */
import { and, eq, isNull, like, or, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'

import type { Db } from '#/db/index.ts'
import { models, providers } from '#/db/schema.ts'
import type { Activity } from '#/db/schema.ts'
import { getServiceStatus } from '#/server/status.ts'

export interface ModelFilters {
  activity?: Activity
  provider?: string
  /** Substring match against the capabilities JSON. */
  capability?: string
  /** Free-text match against id, raw id, and display name. */
  q?: string
  /** Deprecated models are excluded unless set. */
  includeDeprecated?: boolean
}

function modelLinks(providerId: string) {
  return {
    provider: `/v1/providers/${providerId}/models`,
    schemas: `/v1/schemas/${providerId}`,
  }
}

type ModelRow = typeof models.$inferSelect

function toApiModel(row: ModelRow) {
  return {
    id: row.id,
    provider: row.providerId,
    rawId: row.rawId,
    activity: row.activity,
    displayName: row.displayName,
    contextWindow: row.contextWindow,
    maxOutput: row.maxOutput,
    modalities: row.modalities,
    pricing: row.pricing,
    capabilities: row.capabilities,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    deprecatedAt: row.deprecatedAt,
    _links: modelLinks(row.providerId),
  }
}

export type ApiModel = ReturnType<typeof toApiModel>

/** GET /v1/providers — providers with sync status, counts, and links. */
export async function listProvidersCatalog(db: Db) {
  const status = await getServiceStatus(db)
  return {
    providers: status.providers.map((p) => ({
      ...p,
      _links: {
        models: `/v1/providers/${p.id}/models`,
        schemas: `/v1/schemas/${p.id}`,
      },
    })),
    _links: { self: '/v1/providers', catalog: '/v1/models' },
  }
}

/** GET /v1/models — the cross-provider, filterable catalog. */
export async function listModelsCatalog(db: Db, filters: ModelFilters = {}) {
  const conditions: Array<SQL> = []
  if (!filters.includeDeprecated) conditions.push(isNull(models.deprecatedAt))
  if (filters.activity) conditions.push(eq(models.activity, filters.activity))
  if (filters.provider) conditions.push(eq(models.providerId, filters.provider))
  if (filters.capability) {
    conditions.push(like(models.capabilities, `%${filters.capability}%`))
  }
  if (filters.q) {
    const needle = `%${filters.q.toLowerCase()}%`
    const textMatch = or(
      like(models.id, needle),
      like(models.rawId, needle),
      like(sql`lower(coalesce(${models.displayName}, ''))`, needle),
    )
    if (textMatch) conditions.push(textMatch)
  }

  const rows = await db
    .select()
    .from(models)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(models.id)
  return {
    count: rows.length,
    models: rows.map(toApiModel),
    _links: { self: '/v1/models', providers: '/v1/providers' },
  }
}

/** GET /v1/providers/{provider}/models. Returns null for unknown providers. */
export async function listProviderModels(db: Db, providerId: string) {
  const provider = await db.query.providers.findFirst({
    where: eq(providers.id, providerId),
  })
  if (!provider) return null
  const rows = await db
    .select()
    .from(models)
    .where(eq(models.providerId, providerId))
    .orderBy(models.id)
  return {
    provider: provider.id,
    count: rows.length,
    models: rows.map(toApiModel),
    _links: modelLinks(provider.id),
  }
}

/**
 * GET /v1/models/{provider}/{modelId} — accepts the model slug or the raw
 * provider id. Returns null when not found.
 */
export async function getModelDetail(
  db: Db,
  providerId: string,
  modelId: string,
) {
  const row = await db.query.models.findFirst({
    where: and(
      eq(models.providerId, providerId),
      or(eq(models.id, modelId), eq(models.rawId, modelId)),
    ),
  })
  if (!row) return null
  return toApiModel(row)
}

/** Valid provider ids, for 404 remediation messages. */
export async function knownProviderIds(db: Db): Promise<Array<string>> {
  const rows = await db.select({ id: providers.id }).from(providers)
  return rows.map((r) => r.id).sort()
}
