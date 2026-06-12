/**
 * Schema read queries (PLAN.md task 4.3). Endpoint ids exposed publicly are
 * the PR #622 path-derived ids (`v1/messages`, `chat/completions`, …) — the
 * db id minus the `${providerId}/` prefix. Stored schema text is parsed and
 * re-serialised verbatim (JSON.stringify preserves insertion order), so the
 * served bytes match what the sync engine wrote to D1.
 */
import { and, eq, isNull } from 'drizzle-orm'

import type { Db } from '#/db/index.ts'
import { endpoints, providers, schemaVersions } from '#/db/schema.ts'
import type { Activity } from '#/db/schema.ts'
import { halGet } from '#/server/hal.ts'

export function publicEndpointId(dbId: string, providerId: string): string {
  return dbId.startsWith(`${providerId}/`)
    ? dbId.slice(providerId.length + 1)
    : dbId
}

export async function providerExists(
  db: Db,
  providerId: string,
): Promise<boolean> {
  const row = await db.query.providers.findFirst({
    where: eq(providers.id, providerId),
    columns: { id: true },
  })
  return row !== undefined
}

/** GET /v1/schemas/{provider} — activities + endpoint ids. */
export async function getProviderSchemaIndex(db: Db, providerId: string) {
  const rows = await db
    .select({ id: endpoints.id, activity: endpoints.activity })
    .from(endpoints)
    .where(eq(endpoints.providerId, providerId))
    .orderBy(endpoints.id)

  const activities: Partial<Record<Activity, Array<string>>> = {}
  for (const row of rows) {
    ;(activities[row.activity] ??= []).push(
      publicEndpointId(row.id, providerId),
    )
  }
  return {
    provider: providerId,
    count: rows.length,
    activities,
    _links: {
      self: halGet(`/v1/schemas/${providerId}`),
      activity: halGet(`/v1/schemas/${providerId}/{activity}`),
      schema: halGet(
        `/v1/schemas/${providerId}/{activity}/{endpointId}{?kind,version}`,
      ),
    },
  }
}

interface SchemaPair {
  input?: unknown
  output?: unknown
}

/**
 * GET /v1/schemas/{provider}/{activity} — endpoint-id-keyed map of current
 * input/output schemas (the PR's `endpoint-schema-map` shape).
 */
export async function getActivitySchemaMap(
  db: Db,
  providerId: string,
  activity: Activity,
) {
  const rows = await db
    .select({
      endpointId: endpoints.id,
      kind: schemaVersions.kind,
      schema: schemaVersions.schema,
    })
    .from(schemaVersions)
    .innerJoin(endpoints, eq(schemaVersions.endpointId, endpoints.id))
    .where(
      and(
        eq(endpoints.providerId, providerId),
        eq(endpoints.activity, activity),
        isNull(schemaVersions.supersededAt),
      ),
    )
    .orderBy(endpoints.id)

  const map: Record<string, SchemaPair> = {}
  for (const row of rows) {
    const id = publicEndpointId(row.endpointId, providerId)
    ;(map[id] ??= {})[row.kind] = JSON.parse(row.schema) as unknown
  }
  return {
    provider: providerId,
    activity,
    count: Object.keys(map).length,
    endpoints: map,
    _links: {
      self: halGet(`/v1/schemas/${providerId}/${activity}`),
      schema: halGet(
        `/v1/schemas/${providerId}/${activity}/{endpointId}{?kind,version}`,
      ),
    },
  }
}

export interface SchemaProvenance {
  /** Upstream document the schema was derived from. */
  sourceUrl: string | null
  /** SHA-256 of that document as fetched (see SpecSource.hash). */
  sourceHash: string | null
  /** When this version was derived (the row's createdAt). */
  fetchedAt: number
  /** Extraction-pipeline version that produced contentHash. */
  extractorVersion: string | null
}

export interface EndpointSchemaResult {
  provider: string
  activity: Activity
  endpointId: string
  kind: 'input' | 'output'
  contentHash: string
  specRevision: string | null
  provenance: SchemaProvenance
  createdAt: number
  supersededAt: number | null
  schema: unknown
}

/**
 * GET /v1/schemas/{provider}/{activity}/{endpointId}?kind=&version= —
 * a single self-contained JSON Schema; current version unless a content
 * hash is passed. Returns null when the endpoint/kind/version is unknown.
 */
export async function getEndpointSchema(
  db: Db,
  providerId: string,
  activity: Activity,
  endpointId: string,
  kind: 'input' | 'output' = 'input',
  version?: string,
): Promise<EndpointSchemaResult | null> {
  const dbId = `${providerId}/${endpointId}`
  const endpoint = await db.query.endpoints.findFirst({
    where: and(eq(endpoints.id, dbId), eq(endpoints.activity, activity)),
  })
  if (!endpoint) return null

  const row = await db.query.schemaVersions.findFirst({
    where: and(
      eq(schemaVersions.endpointId, dbId),
      eq(schemaVersions.kind, kind),
      version !== undefined
        ? eq(schemaVersions.contentHash, version)
        : isNull(schemaVersions.supersededAt),
    ),
  })
  if (!row) return null

  return {
    provider: providerId,
    activity,
    endpointId,
    kind,
    contentHash: row.contentHash,
    specRevision: row.specRevision,
    provenance: {
      sourceUrl: row.sourceUrl,
      sourceHash: row.sourceHash,
      fetchedAt: row.createdAt,
      extractorVersion: row.extractorVersion,
    },
    createdAt: row.createdAt,
    supersededAt: row.supersededAt,
    schema: JSON.parse(row.schema) as unknown,
  }
}

/** Endpoint-id hints for 404 remediation (capped). */
export async function knownEndpointIds(
  db: Db,
  providerId: string,
  activity?: Activity,
  limit = 25,
): Promise<Array<string>> {
  const rows = await db
    .select({ id: endpoints.id })
    .from(endpoints)
    .where(
      activity
        ? and(
            eq(endpoints.providerId, providerId),
            eq(endpoints.activity, activity),
          )
        : eq(endpoints.providerId, providerId),
    )
    .orderBy(endpoints.id)
    .limit(limit)
  return rows.map((r) => publicEndpointId(r.id, providerId))
}
