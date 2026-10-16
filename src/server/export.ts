/**
 * Catalog export (issue #343): the whole catalog in one response, for the
 * public git mirror. Fields that change on every poll are left out and
 * object keys are sorted, so a mirror commit holds only real changes.
 *
 * The full catalog is tens of MB, more than a Worker can hold as one
 * object. The body is streamed one provider at a time; a failure part way
 * errors the stream, so the client gets no valid JSON and commits nothing.
 */
import { and, desc, eq, isNull } from 'drizzle-orm'

import type { Db } from '#/db/index.ts'
import {
  changes,
  endpoints,
  providerModelNamespaces,
  providers,
  schemaVersions,
} from '#/db/schema.ts'
import { exportProviderModels } from '#/server/catalog.ts'
import type { ApiModel } from '#/server/catalog.ts'
import { errorMessage } from '#/server/errors.ts'
import { publicEndpointId } from '#/server/schemas-api.ts'
import type { SchemaProvenance } from '#/server/schemas-api.ts'

/** Stored JSON text, written to the body as it is. */
class RawJson {
  constructor(readonly text: string) {}
}

/**
 * JSON with every object's keys sorted. A schema is the exception: its
 * stored text is fixed by its content hash, and its key order is the
 * provider's, as `GET /v1/schemas` serves it.
 */
export function stableJson(value: unknown): string {
  if (value instanceof RawJson) return value.text
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item ?? null)).join(',')}]`
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const members = Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    return `{${members.join(',')}}`
  }
  return JSON.stringify(value)
}

/** `lastSeenAt` moves on every poll; `_links` are API navigation. */
function exportModel(model: ApiModel): Partial<ApiModel> {
  const entry: Partial<ApiModel> = { ...model }
  delete entry.lastSeenAt
  delete entry._links
  return entry
}

interface SchemaVersionEntry {
  contentHash: string
  specRevision: string | null
  provenance: SchemaProvenance
  schema: RawJson
}

/** Every endpoint of one provider with its current input and output. */
async function exportProviderSchemas(db: Db, providerId: string) {
  const rows = await db
    .select({ endpoint: endpoints, version: schemaVersions })
    .from(endpoints)
    .leftJoin(
      schemaVersions,
      and(
        eq(schemaVersions.endpointId, endpoints.id),
        isNull(schemaVersions.supersededAt),
      ),
    )
    .where(eq(endpoints.providerId, providerId))
    .orderBy(endpoints.id)

  const byEndpoint = new Map<
    string,
    {
      provider: string
      endpointId: string
      activity: string
      method: string
      path: string
      description: string | null
      input: SchemaVersionEntry | null
      output: SchemaVersionEntry | null
    }
  >()
  for (const { endpoint, version } of rows) {
    let entry = byEndpoint.get(endpoint.id)
    if (!entry) {
      entry = {
        provider: providerId,
        endpointId: publicEndpointId(endpoint.id, providerId),
        activity: endpoint.activity,
        method: endpoint.method,
        path: endpoint.path,
        description: endpoint.description,
        input: null,
        output: null,
      }
      byEndpoint.set(endpoint.id, entry)
    }
    if (version) {
      entry[version.kind] = {
        contentHash: version.contentHash,
        specRevision: version.specRevision,
        provenance: {
          sourceUrl: version.sourceUrl,
          sourceHash: version.sourceHash,
          fetchedAt: version.createdAt,
          extractorVersion: version.extractorVersion,
          derivation: version.derivation,
          verifiedAt: version.verifiedAt,
        },
        schema: new RawJson(version.schema),
      }
    }
  }
  return [...byEndpoint.values()]
}

/**
 * The body in order: `latestChange`, then `models`, `providers`, and
 * `schemas`, each ordered by provider id and then by its own id.
 */
async function* exportChunks(db: Db): AsyncGenerator<string> {
  // Read first: every change it covers is already in the rows below.
  const [latestChange] = await db
    .select({ id: changes.id, createdAt: changes.createdAt })
    .from(changes)
    .orderBy(desc(changes.createdAt), desc(changes.id))
    .limit(1)
  const providerRows = await db.select().from(providers).orderBy(providers.id)
  const namespaceRows = await db
    .select()
    .from(providerModelNamespaces)
    .orderBy(providerModelNamespaces.namespace)

  yield `{"latestChange":${stableJson(latestChange ?? null)},"models":[`
  let separator = ''
  for (const provider of providerRows) {
    const rows = await exportProviderModels(db, provider.id)
    if (rows.length === 0) continue
    yield separator + rows.map((row) => stableJson(exportModel(row))).join(',')
    separator = ','
  }

  const exportedProviders = providerRows.map((provider) => ({
    id: provider.id,
    displayName: provider.displayName,
    specSourceUrl: provider.specSourceUrl,
    modelsEndpoint: provider.modelsEndpoint,
    authEnvVar: provider.authEnvVar,
    status: provider.status,
    modelNamespaces: namespaceRows
      .filter((row) => row.providerId === provider.id)
      .map((row) => row.namespace),
  }))
  yield `],"providers":${stableJson(exportedProviders)},"schemas":[`

  separator = ''
  for (const provider of providerRows) {
    const entries = await exportProviderSchemas(db, provider.id)
    if (entries.length === 0) continue
    yield separator + entries.map((entry) => stableJson(entry)).join(',')
    separator = ','
  }
  yield ']}'
}

/** GET /v1/admin/export — the response body. */
export function exportCatalogStream(db: Db): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const chunks = exportChunks(db)
  return new ReadableStream({
    async pull(controller) {
      try {
        const next = await chunks.next()
        if (next.done) controller.close()
        else controller.enqueue(encoder.encode(next.value))
      } catch (error) {
        console.error(
          JSON.stringify({ job: 'catalog-export', error: errorMessage(error) }),
        )
        controller.error(error)
      }
    },
    async cancel() {
      await chunks.return(undefined)
    },
  })
}
