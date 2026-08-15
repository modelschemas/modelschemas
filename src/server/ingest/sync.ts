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
import { seedForProvider } from '#/db/seed-providers.ts'
import { errorMessage } from '#/server/errors.ts'
import { contentHash, putJson, schemaKey } from '#/server/kv.ts'
import { PROVENANCE_MARKER } from '#/server/providers/types.ts'
import type {
  Derivation,
  EndpointProvenance,
  OpenApiOperation,
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
  /** How this endpoint's schemas were arrived at (the trust ladder). */
  derivation: Derivation
  /** `YYYY-MM-DD` a `probe-verified` claim was last confirmed. */
  verifiedAt: string | null
  input?: Record<string, JsonValue>
  output?: Record<string, JsonValue>
}

function newChangeId(): string {
  return crypto.randomUUID()
}

const DERIVATIONS: ReadonlyArray<Derivation> = [
  'upstream-spec',
  'generated',
  'probe-verified',
  'docs-derived',
]

/**
 * Per-operation provenance annotation, falling back to the provider's
 * default. A malformed marker falls back too rather than throwing — a bad
 * annotation should not sink a sync.
 */
function readProvenance(
  op: OpenApiOperation,
  provider: ProviderConfig,
): { derivation: Derivation; verifiedAt: string | null } {
  const marker = op[PROVENANCE_MARKER]
  if (marker !== null && typeof marker === 'object') {
    const { derivation, verifiedAt } = marker as Partial<EndpointProvenance>
    if (typeof derivation === 'string' && DERIVATIONS.includes(derivation)) {
      return {
        derivation: derivation,
        verifiedAt: typeof verifiedAt === 'string' ? verifiedAt : null,
      }
    }
  }
  return { derivation: provider.defaultDerivation, verifiedAt: null }
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
      const { derivation, verifiedAt } = readProvenance(post, provider)
      classified.push({
        dbId: `${provider.id}/${endpointIdFromPath(pathKey)}`,
        path: pathKey,
        activity,
        description,
        source,
        derivation,
        verifiedAt,
        input: extracted.input,
        output: extracted.output,
      })
    }
  }
  return { endpoints: classified, warnings }
}

/** Sync one provider. Throws only on programmer error — upstream/storage
 * failures surface in the outcome's `error` via syncAllProviders. */
/**
 * Upsert the provider's row from its registry config: refreshes the seeded
 * config columns, preserves runtime state (lastPolledAt/lastSyncedAt/status).
 * Same semantics as `scripts/seed.ts`, run automatically so a newly
 * registered provider self-heals into the DB on its first sync/poll instead
 * of waiting on a manual seed against prod.
 */
export async function ensureProviderRow(
  db: Db,
  provider: ProviderConfig,
): Promise<void> {
  const seed = seedForProvider(provider)
  if (seed === null) return
  await db
    .insert(providers)
    .values(seed)
    .onConflictDoUpdate({
      target: providers.id,
      set: {
        displayName: seed.displayName,
        specSourceUrl: seed.specSourceUrl,
        modelsEndpoint: seed.modelsEndpoint ?? null,
        authEnvVar: seed.authEnvVar ?? null,
      },
    })
}

/** Composite map key for an endpoint's current version of one kind. */
function versionKey(endpointId: string, kind: 'input' | 'output'): string {
  return `${endpointId}\u0000${kind}`
}

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
  await ensureProviderRow(db, provider)

  const fetched = await provider.fetchSpec(secrets)
  if (fetched.warnings) outcome.warnings.push(...fetched.warnings)
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

  // Current (non-superseded) versions for the whole provider in one query.
  // Per-endpoint lookups here are 2 D1 round trips per endpoint — FAL alone
  // has ~1,400 endpoints, which blows the invocation's 1,000-subrequest
  // budget (and its wall clock) before the sync can complete, leaving the
  // provider stuck degraded. Same batching treatment as poll-models.
  const currentVersionRows = await db
    .select({
      id: schemaVersions.id,
      endpointId: schemaVersions.endpointId,
      kind: schemaVersions.kind,
      contentHash: schemaVersions.contentHash,
    })
    .from(schemaVersions)
    .innerJoin(endpoints, eq(schemaVersions.endpointId, endpoints.id))
    .where(
      and(
        eq(endpoints.providerId, provider.id),
        isNull(schemaVersions.supersededAt),
      ),
    )
  const currentByEndpointKind = new Map(
    currentVersionRows.map((v) => [versionKey(v.endpointId, v.kind), v]),
  )

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
      const current = currentByEndpointKind.get(versionKey(endpoint.dbId, kind))
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
          derivation: endpoint.derivation,
          verifiedAt: endpoint.verifiedAt,
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
            derivation: endpoint.derivation,
            verifiedAt: endpoint.verifiedAt,
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
  // the rows — schema version history stays queryable. The already-recorded
  // set loads in one query: vanished endpoints accumulate for good (rows are
  // kept), so per-endpoint lookups would cost one subrequest each, forever.
  const seenIds = new Set(classified.map((e) => e.dbId))
  const removalRows = await db
    .select({ subjectId: changes.subjectId })
    .from(changes)
    .where(
      and(
        eq(changes.type, 'endpoint.removed'),
        eq(changes.providerId, provider.id),
      ),
    )
  const alreadyRemovedIds = new Set(removalRows.map((r) => r.subjectId))
  for (const existing of existingEndpoints) {
    if (seenIds.has(existing.id)) continue
    if (alreadyRemovedIds.has(existing.id)) continue
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
 * Spec-sync shard schedule: each cron fires its own Worker invocation with
 * a fresh subrequest/CPU/memory budget, so one provider's blowup can't
 * starve the providers behind it (production data: FAL's oversized sync
 * killed the shared 05:00 run mid-flight daily, leaving every provider
 * after it in the registry permanently unsynced). Shard 0 is FAL alone —
 * by far the largest (~1,400 per-model specs); the rest of the registry
 * round-robins across the remaining shards, which also spreads the other
 * big-spec providers (they're adjacent in the registry). Keep this array
 * in lockstep with `triggers.crons` in wrangler.jsonc.
 */
export const SPEC_SYNC_SHARD_CRONS = [
  '0 5 * * *',
  '10 5 * * *',
  '20 5 * * *',
  '30 5 * * *',
] as const

export function specSyncShard(shardIndex: number): Array<ProviderConfig> {
  const rest = providerRegistry.filter((p) => p.id !== 'fal')
  if (shardIndex === 0) return providerRegistry.filter((p) => p.id === 'fal')
  const restShards = SPEC_SYNC_SHARD_CRONS.length - 1
  return rest.filter((_, i) => i % restShards === shardIndex - 1)
}

/**
 * Sync the given providers (default: the full registry), sequentially
 * (subrequest limits), with per-provider isolation: one provider's outage
 * doesn't sink the run.
 */
export async function syncAllProviders(
  deps: SyncDeps,
  providersToSync: Array<ProviderConfig> = providerRegistry,
): Promise<Array<SyncOutcome>> {
  const outcomes: Array<SyncOutcome> = []
  for (const provider of providersToSync) {
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
      try {
        await deps.db
          .update(providers)
          .set({ status: 'degraded' })
          .where(eq(providers.id, provider.id))
      } catch (statusError) {
        // Best-effort: if the failure was resource exhaustion (subrequest
        // budget), this write fails too — don't let it sink the run.
        console.error(
          JSON.stringify({
            job: 'spec-sync',
            providerId: provider.id,
            error: `degraded-status write failed: ${errorMessage(statusError)}`,
          }),
        )
      }
    }
  }
  return outcomes
}
