/**
 * Sync engine (PLAN.md task 2.3): per provider — fetch spec → classify
 * endpoints → bundle schemas → diff content hashes against
 * `schema_versions` → insert new versions (reviving superseded rows when
 * upstream reverts to previously seen content), mark superseded, upsert
 * `endpoints`, write `changes` rows, warm KV with new blobs. Idempotent.
 */
import { and, eq, isNull } from 'drizzle-orm'

import type { Db } from '#/db/index.ts'
import { changes, endpoints, providers, schemaVersions } from '#/db/schema.ts'
import type { Activity } from '#/db/schema.ts'
import { errorMessage } from '#/server/errors.ts'
import { contentHash, putJson, schemaKey } from '#/server/kv.ts'
import type {
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
  SpecSource,
} from '#/server/providers/types.ts'
import { providerRegistry } from '#/server/providers/index.ts'
import {
  EXTRACTOR_VERSION,
  endpointIdFromPath,
  extractEndpointSchemas,
  findDanglingRefs,
} from './bundle.ts'
import type { JsonValue } from './bundle.ts'

export interface SyncDeps {
  db: Db
  kv: KVNamespace
  secrets: ProviderSecrets
  /** Injectable clock (unix epoch seconds) for deterministic tests. */
  now?: () => number
}

export interface SyncOutcome {
  providerId: string
  endpointsSeen: number
  versionsAdded: number
  changesWritten: number
  skipped?: string
  error?: string
  warnings: Array<string>
}

export interface ClassifiedEndpoint {
  /** Globally unique db id: `${providerId}/${pathId}`. */
  dbId: string
  path: string
  activity: Activity
  description: string | null
  /** Provenance of the spec document this endpoint came from. */
  source: SpecSource | null
  input?: Record<string, JsonValue>
  output?: Record<string, JsonValue>
}

function newChangeId(): string {
  return crypto.randomUUID()
}

/**
 * Classify + bundle every generation endpoint across a provider's fetched
 * specs. Pure (no storage) — shared by the sync engine and the offline
 * re-derivation script (`scripts/rederive.ts`), so both always derive
 * identical content hashes from the same upstream documents.
 */
export function classifyAndBundle(
  provider: ProviderConfig,
  fetched: SpecFetchResult,
): { endpoints: Array<ClassifiedEndpoint>; warnings: Array<string> } {
  const classified: Array<ClassifiedEndpoint> = []
  const warnings: Array<string> = []
  for (const [specIndex, spec] of fetched.specs.entries()) {
    const source = fetched.sources[specIndex] ?? null
    for (const [pathKey, operations] of Object.entries(spec.paths ?? {})) {
      const post = operations.post
      if (!post) continue
      const activity = provider.classify(pathKey, post)
      if (activity === null) continue

      const extracted = extractEndpointSchemas(
        spec,
        pathKey,
        fetched.outputStrategy,
      )
      warnings.push(...extracted.warnings)
      for (const [kind, schema] of [
        ['input', extracted.input],
        ['output', extracted.output],
      ] as const) {
        if (schema && findDanglingRefs(schema).length > 0) {
          warnings.push(
            `${provider.id}${pathKey}: bundled ${kind} schema has dangling refs`,
          )
        }
      }
      if (!extracted.input && !extracted.output) continue

      const description =
        typeof post.summary === 'string'
          ? post.summary
          : typeof post.description === 'string'
            ? post.description
            : null
      classified.push({
        dbId: `${provider.id}/${endpointIdFromPath(pathKey)}`,
        path: pathKey,
        activity,
        description,
        source,
        input: extracted.input,
        output: extracted.output,
      })
    }
  }
  return { endpoints: classified, warnings }
}

/** Sync one provider. Throws only on programmer error — upstream/storage
 * failures surface in the outcome's `error` via syncAllProviders. */
export async function syncProvider(
  deps: SyncDeps,
  provider: ProviderConfig,
): Promise<SyncOutcome> {
  const { db, kv, secrets } = deps
  const now = deps.now?.() ?? Math.floor(Date.now() / 1000)
  const outcome: SyncOutcome = {
    providerId: provider.id,
    endpointsSeen: 0,
    versionsAdded: 0,
    changesWritten: 0,
    warnings: [],
  }

  const fetched = await provider.fetchSpec(secrets)
  if (fetched.skipped) {
    outcome.skipped = fetched.skipped
    outcome.warnings.push(fetched.skipped)
    return outcome
  }

  const { endpoints: classified, warnings } = classifyAndBundle(
    provider,
    fetched,
  )
  outcome.warnings.push(...warnings)
  outcome.endpointsSeen = classified.length

  const existingEndpoints = await db
    .select()
    .from(endpoints)
    .where(eq(endpoints.providerId, provider.id))
  const existingById = new Map(existingEndpoints.map((e) => [e.id, e]))

  for (const endpoint of classified) {
    const existing = existingById.get(endpoint.dbId)
    if (!existing) {
      await db.insert(endpoints).values({
        id: endpoint.dbId,
        providerId: provider.id,
        activity: endpoint.activity,
        method: 'POST',
        path: endpoint.path,
        description: endpoint.description,
      })
      await db.insert(changes).values({
        id: newChangeId(),
        type: 'endpoint.added',
        providerId: provider.id,
        subjectId: endpoint.dbId,
        summary: `Endpoint ${endpoint.path} added (${endpoint.activity})`,
        createdAt: now,
      })
      outcome.changesWritten++
    } else if (
      existing.activity !== endpoint.activity ||
      existing.description !== endpoint.description
    ) {
      await db
        .update(endpoints)
        .set({
          activity: endpoint.activity,
          description: endpoint.description,
        })
        .where(eq(endpoints.id, endpoint.dbId))
    }

    for (const [kind, schema] of [
      ['input', endpoint.input],
      ['output', endpoint.output],
    ] as const) {
      if (!schema) continue
      const hash = await contentHash(schema)
      const current = await db.query.schemaVersions.findFirst({
        where: and(
          eq(schemaVersions.endpointId, endpoint.dbId),
          eq(schemaVersions.kind, kind),
          isNull(schemaVersions.supersededAt),
        ),
      })
      if (current?.contentHash === hash) continue

      // The id is deterministic on content, so when upstream reverts to a
      // previously served schema (A → B → A) the row already exists as a
      // superseded version — revive it instead of colliding on the insert.
      await db
        .insert(schemaVersions)
        .values({
          id: `${endpoint.dbId}:${kind}:${hash.slice(0, 16)}`,
          endpointId: endpoint.dbId,
          kind,
          contentHash: hash,
          schema: JSON.stringify(schema),
          specRevision: fetched.specRevision ?? null,
          sourceUrl: endpoint.source?.url ?? null,
          sourceHash: endpoint.source?.hash ?? null,
          extractorVersion: EXTRACTOR_VERSION,
          createdAt: now,
        })
        .onConflictDoUpdate({
          target: schemaVersions.id,
          set: {
            supersededAt: null,
            specRevision: fetched.specRevision ?? null,
            sourceUrl: endpoint.source?.url ?? null,
            sourceHash: endpoint.source?.hash ?? null,
            extractorVersion: EXTRACTOR_VERSION,
            createdAt: now,
          },
        })
      outcome.versionsAdded++
      await putJson(kv, schemaKey(hash), schema)

      if (current) {
        await db
          .update(schemaVersions)
          .set({ supersededAt: now })
          .where(eq(schemaVersions.id, current.id))
      }
      await db.insert(changes).values({
        id: newChangeId(),
        type: current ? 'schema.updated' : 'schema.added',
        providerId: provider.id,
        subjectId: endpoint.dbId,
        summary: `${current ? 'Updated' : 'Added'} ${kind} schema for ${endpoint.path}`,
        payload: {
          kind,
          contentHash: hash,
          previousHash: current?.contentHash ?? null,
        },
        createdAt: now,
      })
      outcome.changesWritten++
    }
  }

  // Endpoints in D1 that vanished from the spec: record the removal but keep
  // the rows — schema version history stays queryable.
  const seenIds = new Set(classified.map((e) => e.dbId))
  for (const existing of existingEndpoints) {
    if (seenIds.has(existing.id)) continue
    const alreadyRemoved = await db.query.changes.findFirst({
      where: and(
        eq(changes.type, 'endpoint.removed'),
        eq(changes.subjectId, existing.id),
      ),
    })
    if (alreadyRemoved) continue
    await db.insert(changes).values({
      id: newChangeId(),
      type: 'endpoint.removed',
      providerId: provider.id,
      subjectId: existing.id,
      summary: `Endpoint ${existing.path} removed from the ${provider.id} spec`,
      createdAt: now,
    })
    outcome.changesWritten++
  }

  await db
    .update(providers)
    .set({ lastSyncedAt: now, status: 'active' })
    .where(eq(providers.id, provider.id))

  return outcome
}

/**
 * Sync every registered provider, sequentially (subrequest limits), with
 * per-provider isolation: one provider's outage doesn't sink the run.
 */
export async function syncAllProviders(
  deps: SyncDeps,
): Promise<Array<SyncOutcome>> {
  const outcomes: Array<SyncOutcome> = []
  for (const provider of providerRegistry) {
    try {
      outcomes.push(await syncProvider(deps, provider))
    } catch (error) {
      const message = errorMessage(error)
      // Own log line per failure: the aggregate outcomes blob can exceed
      // what Workers Logs stores, which silently loses these errors.
      console.error(
        JSON.stringify({
          job: 'spec-sync',
          providerId: provider.id,
          error: message,
        }),
      )
      outcomes.push({
        providerId: provider.id,
        endpointsSeen: 0,
        versionsAdded: 0,
        changesWritten: 0,
        error: message,
        warnings: [],
      })
      await deps.db
        .update(providers)
        .set({ status: 'degraded' })
        .where(eq(providers.id, provider.id))
    }
  }
  return outcomes
}
