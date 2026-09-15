/**
 * Model poller (PLAN.md task 2.4) — the fast 15-minute tier: per provider,
 * list currently served models, diff against D1, write
 * model.added/removed/updated changes, bump lastSeenAt. Listings compile to
 * RateCards (or null) before insert/update.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'

import {
  changes,
  endpoints,
  models,
  providers,
  schemaVersions,
} from '#/db/schema.ts'
import { errorMessage } from '#/server/errors.ts'
import { stableStringify } from '#/server/kv.ts'
import { resolveSpecGrain } from '#/server/providers/connect.ts'
import {
  mergeListingAndSchema,
  requestSchemaPropertyNames,
  schemaRung,
  walkRequestSchema,
} from '#/server/providers/fact-sources.ts'
import type { SchemaWalk } from '#/server/providers/fact-sources.ts'
import {
  parseStoredRateCard,
  reconcilePricingSource,
  storeListedPricing,
} from '#/server/rate-card.ts'
import type { RateCardRefuse } from '#/server/rate-card.ts'
import type { ModelInfo, ProviderConfig } from '#/server/providers/types.ts'
import { providerRegistry } from '#/server/providers/index.ts'
import { resolveSchemaEndpointId } from '#/server/schema-binding.ts'
import { preserveAsyncApiFlag } from './asyncapi.ts'
import { ensureProviderRow } from './sync.ts'
import type { SyncDeps } from './sync.ts'

export interface PollOutcome {
  providerId: string
  modelsSeen: number
  added: number
  removed: number
  updated: number
  /** Rows whose firstSeenAt moved back to the upstream release date. */
  backdated: number
  skipped?: string
  error?: string
}

/** Deterministic model row id: `${providerId}-${slugified rawId}`. */
export function modelDbId(providerId: string, rawId: string): string {
  const slug = rawId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${providerId}-${slug}`
}

/**
 * Reject obviously bogus upstream release timestamps (0, negative, or
 * pre-2015 — years before any monitored provider existed).
 */
const RELEASED_AT_FLOOR = 1_420_070_400 // 2015-01-01T00:00:00Z

/**
 * Upstream release time usable for firstSeenAt: sane, and never later than
 * the reference time (we backdate, never forward-date).
 */
function usableReleasedAt(info: ModelInfo, before: number): number | null {
  const releasedAt = info.releasedAt ?? null
  if (releasedAt === null) return null
  if (releasedAt < RELEASED_AT_FLOOR || releasedAt >= before) return null
  return releasedAt
}

/** The fields whose changes constitute a `model.updated` event. */
function comparable(info: ModelInfo): Record<string, unknown> {
  return {
    displayName: info.displayName ?? null,
    activity: info.activity ?? null,
    contextWindow: info.contextWindow ?? null,
    maxOutput: info.maxOutput ?? null,
    modalities: info.modalities ?? null,
    pricing: info.pricing ?? null,
    capabilities: info.capabilities ?? null,
    schemaEndpointId: info.schemaEndpointId ?? null,
    deprecated: info.deprecated ?? false,
  }
}

type InputWalks = {
  walks: Map<string, SchemaWalk>
  properties: Map<string, Set<string>>
}

async function loadInputWalks(
  db: SyncDeps['db'],
  provider: ProviderConfig,
  listed: Array<ModelInfo>,
): Promise<InputWalks> {
  const walks = new Map<string, SchemaWalk>()
  const properties = new Map<string, Set<string>>()
  const skipFactWalk =
    resolveSpecGrain(provider) === 'model' ||
    provider.defaultDerivation === 'generated'
  // Grain=model / generated listings skip the capability walk (thousands of
  // FAL endpoints; OpenAI-borrowed specs must not stamp flags). Still load
  // request property names when a listing already carries a RateCard so
  // invented request-bound params refuse the write.
  const needsRequestCheck = listed.some(
    (info) => parseStoredRateCard(info.pricing) !== null,
  )
  if (skipFactWalk && !needsRequestCheck) {
    return { walks, properties }
  }
  const bound = new Set<string>()
  for (const info of listed) {
    const id = resolveSchemaEndpointId({
      providerId: provider.id,
      rawId: info.rawId,
      activity: info.activity ?? null,
      capabilities: info.capabilities,
      schemaEndpointId: info.schemaEndpointId,
    })
    if (id) bound.add(id)
  }
  if (bound.size === 0) return { walks, properties }
  const dbIds = [...bound].map((id) => `${provider.id}/${id}`)
  const chunks: Array<Array<string>> = []
  for (let i = 0; i < dbIds.length; i += 90) {
    chunks.push(dbIds.slice(i, i + 90))
  }
  const rows = (
    await Promise.all(
      chunks.map((chunk) =>
        db
          .select({
            endpointId: schemaVersions.endpointId,
            schema: schemaVersions.schema,
            derivation: schemaVersions.derivation,
            sourceUrl: schemaVersions.sourceUrl,
            sourceHash: schemaVersions.sourceHash,
            createdAt: schemaVersions.createdAt,
          })
          .from(schemaVersions)
          .innerJoin(endpoints, eq(schemaVersions.endpointId, endpoints.id))
          .where(
            and(
              inArray(schemaVersions.endpointId, chunk),
              eq(schemaVersions.kind, 'input'),
              isNull(schemaVersions.supersededAt),
            ),
          ),
      ),
    )
  ).flat()
  const prefix = `${provider.id}/`
  for (const row of rows) {
    const publicId = row.endpointId.startsWith(prefix)
      ? row.endpointId.slice(prefix.length)
      : row.endpointId
    const parsed: unknown = JSON.parse(row.schema)
    properties.set(publicId, requestSchemaPropertyNames(parsed))
    if (skipFactWalk) continue
    const rung = schemaRung(row.derivation)
    if (rung === null) continue
    const walk = walkRequestSchema(parsed, {
      derivation: rung,
      endpointId: publicId,
      sourceUrl: row.sourceUrl,
      sourceHash: row.sourceHash,
      fetchedAt: row.createdAt,
    })
    if (walk) walks.set(publicId, walk)
  }
  return { walks, properties }
}

function logRefusedCard(
  providerId: string,
  rawId: string,
  refused: RateCardRefuse,
  hadStoredCard: boolean,
): void {
  // Uncompilable zeros/blobs are the common listing case; only log when we
  // drop a card that was already stored, or when a RateCard fails the write
  // gate (invented param / examples).
  if (refused === 'uncompilable' && !hadStoredCard) return
  console.error(
    JSON.stringify({
      job: 'models-poll',
      providerId,
      rawId,
      error: 'rate_card_refused',
      reason: refused,
    }),
  )
}

function listingSourceUrl(provider: ProviderConfig): string {
  return (
    provider.modelsEndpoint ??
    provider.specSourceUrl ??
    `https://modelschemas.com/v1/providers/${provider.id}`
  )
}

function enrichListed(
  provider: ProviderConfig,
  info: ModelInfo,
  walks: Map<string, SchemaWalk>,
): ModelInfo {
  const bound = resolveSchemaEndpointId({
    providerId: provider.id,
    rawId: info.rawId,
    activity: info.activity ?? null,
    capabilities: info.capabilities,
    schemaEndpointId: info.schemaEndpointId,
  })
  const walk = bound ? (walks.get(bound) ?? null) : null
  const merged = mergeListingAndSchema(info, walk)
  return {
    ...info,
    contextWindow: merged.contextWindow,
    maxOutput: merged.maxOutput,
    modalities: merged.modalities,
    pricing: merged.pricing,
    capabilities: merged.capabilities,
    factSources: merged.factSources ?? undefined,
  }
}

export async function pollProviderModels(
  deps: SyncDeps,
  provider: ProviderConfig,
): Promise<PollOutcome> {
  const { db, secrets } = deps
  const now = deps.now?.() ?? Math.floor(Date.now() / 1000)
  const outcome: PollOutcome = {
    providerId: provider.id,
    modelsSeen: 0,
    added: 0,
    removed: 0,
    updated: 0,
    backdated: 0,
  }
  await ensureProviderRow(db, provider)

  const listed = await provider.listModels(secrets, deps.kv)
  if (listed.skipped) {
    outcome.skipped = listed.skipped
    return outcome
  }
  outcome.modelsSeen = listed.models.length

  const { walks, properties } = await loadInputWalks(
    db,
    provider,
    listed.models,
  )

  const existingRows = await db
    .select()
    .from(models)
    .where(eq(models.providerId, provider.id))
  const existingById = new Map(existingRows.map((m) => [m.id, m]))
  const seenIds = new Set<string>()
  // Unchanged rows only need their lastSeenAt bumped; collect them and write
  // in chunked bulk UPDATEs. One-per-row writes here previously cost ~2,000
  // sequential D1 round trips per poll (~10 min wall), starving the crons.
  const cleanIds: Array<string> = []
  // Otherwise-unchanged rows that need firstSeenAt backdated. Written in
  // chunked bulk UPDATEs like cleanIds: each D1 query is a subrequest
  // against the invocation's 1,000 budget, and the first pass after deploy
  // backdates nearly every row (~1,900 across providers) — one-per-row
  // writes would exhaust the budget mid-poll.
  const backdates: Array<{ id: string; firstSeenAt: number }> = []

  for (const raw of listed.models) {
    const enriched = enrichListed(provider, raw, walks)
    const id = modelDbId(provider.id, enriched.rawId)
    const bound = resolveSchemaEndpointId({
      providerId: provider.id,
      rawId: enriched.rawId,
      activity: enriched.activity ?? null,
      capabilities: enriched.capabilities,
      schemaEndpointId: enriched.schemaEndpointId,
    })
    const existingPricing = existingById.get(id)?.pricing
    const stored = await storeListedPricing(enriched.pricing, {
      existing: existingPricing,
      requestProperties: bound
        ? (properties.get(bound) ?? new Set())
        : undefined,
      sourceUrl: listingSourceUrl(provider),
      now,
    })
    if (stored.refused) {
      logRefusedCard(
        provider.id,
        enriched.rawId,
        stored.refused,
        parseStoredRateCard(existingPricing) !== null,
      )
    }
    const card = stored.card
    const info: ModelInfo = {
      ...enriched,
      pricing: card,
      factSources:
        reconcilePricingSource(enriched.factSources, card) ?? undefined,
    }
    if (seenIds.has(id)) continue // defensive: provider returned a dup
    seenIds.add(id)
    const existing = existingById.get(id)

    if (!existing) {
      await db.insert(models).values({
        id,
        providerId: provider.id,
        rawId: info.rawId,
        activity: info.activity ?? null,
        displayName: info.displayName ?? null,
        contextWindow: info.contextWindow ?? null,
        maxOutput: info.maxOutput ?? null,
        modalities: info.modalities ?? null,
        pricing: info.pricing ?? null,
        capabilities: info.capabilities ?? null,
        factSources: info.factSources ?? null,
        schemaEndpointId: info.schemaEndpointId ?? null,
        // Providers that report a release date get it as firstSeenAt, so
        // models predating our monitoring carry their historical date.
        firstSeenAt: usableReleasedAt(info, now) ?? now,
        lastSeenAt: now,
        deprecatedAt: info.deprecated ? now : null,
      })
      await db.insert(changes).values({
        id: crypto.randomUUID(),
        type: 'model.added',
        providerId: provider.id,
        subjectId: id,
        summary: `Model ${info.rawId} added`,
        createdAt: now,
      })
      outcome.added++
      continue
    }

    const before = {
      displayName: existing.displayName,
      activity: existing.activity,
      contextWindow: existing.contextWindow,
      maxOutput: existing.maxOutput,
      modalities: existing.modalities,
      pricing: existing.pricing,
      capabilities: existing.capabilities,
      schemaEndpointId: existing.schemaEndpointId,
      deprecated: existing.deprecatedAt !== null,
    }
    const after = comparable({
      ...info,
      capabilities: preserveAsyncApiFlag(
        existing.capabilities,
        info.capabilities ?? null,
      ),
    })
    const dirty = stableStringify(before) !== stableStringify(after)

    // Upstream reports a release date earlier than our observed firstSeenAt
    // → backdate in place. A silent correction (no model.updated event):
    // it converges once per row, and the fleet-wide first pass would
    // otherwise flood the changes feed and webhook fan-out.
    const backdatedFirstSeen = usableReleasedAt(info, existing.firstSeenAt)
    if (backdatedFirstSeen !== null) outcome.backdated++

    if (!dirty) {
      if (backdatedFirstSeen === null) cleanIds.push(id)
      else backdates.push({ id, firstSeenAt: backdatedFirstSeen })
      continue
    }

    await db
      .update(models)
      .set({
        lastSeenAt: now,
        ...(backdatedFirstSeen !== null
          ? { firstSeenAt: backdatedFirstSeen }
          : {}),
        displayName: info.displayName ?? null,
        activity: info.activity ?? null,
        contextWindow: info.contextWindow ?? null,
        maxOutput: info.maxOutput ?? null,
        modalities: info.modalities ?? null,
        pricing: info.pricing ?? null,
        capabilities: after.capabilities ?? null,
        factSources: info.factSources ?? null,
        schemaEndpointId: info.schemaEndpointId ?? null,
        // A model that reappears (or upstream re-activates) clears
        // its deprecation; an upstream-deprecated one gains it.
        deprecatedAt:
          (info.deprecated ?? false) ? (existing.deprecatedAt ?? now) : null,
      })
      .where(eq(models.id, id))

    await db.insert(changes).values({
      id: crypto.randomUUID(),
      type: 'model.updated',
      providerId: provider.id,
      subjectId: id,
      summary: `Model ${info.rawId} updated`,
      payload: { before, after },
      createdAt: now,
    })
    outcome.updated++
  }

  // Bump lastSeenAt for the unchanged majority in chunks that stay under
  // D1's 100-bound-parameter-per-statement limit.
  for (let i = 0; i < cleanIds.length; i += 90) {
    await db
      .update(models)
      .set({ lastSeenAt: now })
      .where(inArray(models.id, cleanIds.slice(i, i + 90)))
  }

  // Backdates carry a per-row value, so bulk-update via CASE. Three bound
  // params per row (CASE arm + IN member) + one for lastSeenAt → 30 rows
  // stays under the 100-param limit.
  for (let i = 0; i < backdates.length; i += 30) {
    const chunk = backdates.slice(i, i + 30)
    const arms = sql.join(
      chunk.map((b) => sql`WHEN ${b.id} THEN ${b.firstSeenAt}`),
      sql` `,
    )
    await db
      .update(models)
      .set({
        firstSeenAt: sql`CASE ${models.id} ${arms} END`,
        lastSeenAt: now,
      })
      .where(
        inArray(
          models.id,
          chunk.map((b) => b.id),
        ),
      )
  }

  // Models in D1 the provider no longer lists → mark deprecated once.
  for (const existing of existingRows) {
    if (seenIds.has(existing.id) || existing.deprecatedAt !== null) continue
    await db
      .update(models)
      .set({ deprecatedAt: now })
      .where(eq(models.id, existing.id))
    await db.insert(changes).values({
      id: crypto.randomUUID(),
      type: 'model.removed',
      providerId: provider.id,
      subjectId: existing.id,
      summary: `Model ${existing.rawId} no longer listed`,
      createdAt: now,
    })
    outcome.removed++
  }

  await db
    .update(providers)
    .set({ lastPolledAt: now })
    .where(eq(providers.id, provider.id))

  return outcome
}

/** Poll every registered provider with per-provider failure isolation. */
export async function pollAllProviders(
  deps: SyncDeps,
): Promise<Array<PollOutcome>> {
  const outcomes: Array<PollOutcome> = []
  for (const provider of providerRegistry) {
    try {
      outcomes.push(await pollProviderModels(deps, provider))
    } catch (error) {
      const message = errorMessage(error)
      // Own log line per failure: the aggregate outcomes blob can exceed
      // what Workers Logs stores, which silently loses these errors.
      console.error(
        JSON.stringify({
          job: 'models-poll',
          providerId: provider.id,
          error: message,
        }),
      )
      outcomes.push({
        providerId: provider.id,
        modelsSeen: 0,
        added: 0,
        removed: 0,
        updated: 0,
        backdated: 0,
        error: message,
      })
    }
  }
  return outcomes
}
