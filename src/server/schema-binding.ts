/**
 * Grain=provider model → generation-route binding (issue #50).
 *
 * Catalog rows carry `schemaEndpointId` (the public endpoint id of the
 * shared HTTP route). Schema reads also accept the model rawId / slug as
 * an alias onto that route, pinning the request `model` field to the one
 * id so a Run form can be built the same way as for model-grained FAL.
 */
import { and, eq, or } from 'drizzle-orm'

import type { Db } from '#/db/index.ts'
import { endpoints, models } from '#/db/schema.ts'
import type { Activity } from '#/db/schema.ts'
import { getProvider } from '#/server/providers/index.ts'
import { resolveSpecGrain } from '#/server/providers/connect.ts'

export interface SchemaBindingModel {
  providerId: string
  rawId: string
  activity: Activity | null
  capabilities?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Canonical generation route for a listed model, or null when the
 * provider has no binding (and is not model-grained).
 */
export function resolveSchemaEndpointId(
  row: SchemaBindingModel,
): string | null {
  const config = getProvider(row.providerId)
  if (row.activity !== null && config?.generationEndpointId) {
    const bound = config.generationEndpointId({
      rawId: row.rawId,
      activity: row.activity,
      capabilities: row.capabilities,
    })
    if (bound) return bound
  }
  if (resolveSpecGrain(config) === 'model') return row.rawId
  return null
}

/** Narrow a request schema's `model` property to one listed id. */
export function pinModelField(schema: unknown, rawId: string): unknown {
  if (!isRecord(schema)) return schema
  const properties = schema.properties
  if (!isRecord(properties) || !('model' in properties)) return schema
  const existing = isRecord(properties.model) ? properties.model : {}
  const pinned: Record<string, unknown> = {
    ...existing,
    type: 'string',
    enum: [rawId],
  }
  delete pinned.const
  if ('example' in pinned) pinned.example = rawId
  if ('examples' in pinned) pinned.examples = [rawId]
  return { ...schema, properties: { ...properties, model: pinned } }
}

export interface ResolvedEndpoint {
  /** Db id: `${providerId}/${publicId}`. */
  dbId: string
  /** Public endpoint id (path-derived). */
  publicId: string
  activity: Activity
  /**
   * When the lookup was a model-id alias, the listed rawId to pin on the
   * input schema. Null for a direct endpoint hit.
   */
  pinRawId: string | null
}

/**
 * Resolve a public endpoint id OR a listed model rawId/slug to a stored
 * endpoint. `activity` is required for schema reads (the URL includes it);
 * validate omits it and uses the model's stored activity.
 */
export async function resolveEndpointAlias(
  db: Db,
  providerId: string,
  endpointId: string,
  activity?: Activity,
): Promise<ResolvedEndpoint | null> {
  const dbId = `${providerId}/${endpointId}`
  const direct = await db.query.endpoints.findFirst({
    where:
      activity === undefined
        ? eq(endpoints.id, dbId)
        : and(eq(endpoints.id, dbId), eq(endpoints.activity, activity)),
  })
  if (direct) {
    return {
      dbId,
      publicId: endpointId,
      activity: direct.activity,
      pinRawId: null,
    }
  }

  const model = await db.query.models.findFirst({
    where: and(
      eq(models.providerId, providerId),
      or(eq(models.id, endpointId), eq(models.rawId, endpointId)),
    ),
  })
  if (!model || model.activity === null) return null
  if (activity !== undefined && model.activity !== activity) return null

  const bound = resolveSchemaEndpointId({
    providerId: model.providerId,
    rawId: model.rawId,
    activity: model.activity,
    capabilities: model.capabilities,
  })
  if (!bound || bound === endpointId) return null

  const boundDbId = `${providerId}/${bound}`
  const boundRow = await db.query.endpoints.findFirst({
    where: and(
      eq(endpoints.id, boundDbId),
      eq(endpoints.activity, model.activity),
    ),
  })
  if (!boundRow) return null
  return {
    dbId: boundDbId,
    publicId: bound,
    activity: model.activity,
    pinRawId: model.rawId,
  }
}
