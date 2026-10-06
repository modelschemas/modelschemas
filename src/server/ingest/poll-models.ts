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
  emptySources,
  mergeListingAndSchema,
  modelBranchSchemas,
  requestSchemaPropertyNames,
  schemaRung,
  walkRequestSchema,
} from '#/server/providers/fact-sources.ts'
import type { SchemaWalk } from '#/server/providers/fact-sources.ts'
import { chatRequestMap } from '#/server/providers/request-map.ts'
import {
  parseStoredRateCard,
  reconcilePricingSource,
  storeListedPricing,
} from '#/server/rate-card.ts'
import type { RateCardRefuse } from '#/server/rate-card.ts'
import type {
  DocsFailures,
  ModelFact,
  ModelFactSources,
  ModelInfo,
  ProviderConfig,
} from '#/server/providers/types.ts'
import { providerRegistry } from '#/server/providers/index.ts'
import { storedAliases } from '#/server/providers/provider-aliases.ts'
import { resolveSchemaEndpointId } from '#/server/schema-binding.ts'
import { preserveAsyncApiFlag } from './asyncapi.ts'
import { recordDocsFailing } from './docs-failing.ts'
import type { DocsFailing } from './docs-failing.ts'
import {
  captureIngestEvents,
  runIngestScope,
  ingestFailedEvent,
  noteIngest,
  observePricingWrite,
} from './ingest-signals.ts'
import {
  deprecateFrozenModelsDevCatalog,
  dropModelsDevSchemaVersions,
  isModelsDevRateCard,
  markModelsDevCatalogSettled,
  nullModelsDevRateCards,
  storedCardIsPrior,
} from './retire-models-dev.ts'
import { ensureProviderRow } from './sync.ts'
import type { SyncDeps } from './sync.ts'
import {
  persistUpstreamIdentities,
  reconcileSameAs,
  sameEvidence,
} from './model-identity.ts'
import type { UpstreamIdentityWrite } from './model-identity.ts'

export interface PollOutcome {
  providerId: string
  modelsSeen: number
  added: number
  removed: number
  updated: number
  /** Rows whose firstSeenAt moved back to the upstream release date. */
  backdated: number
  /**
   * Per-row pricing misses and write-gate refusals. A thrown poll is 1
   * here as well as `error` — not only the whole-provider failure.
   */
  failures: number
  /** Docs sources that failed this poll; their rows kept stored facts. */
  docsFailures?: DocsFailures
  /** The provider's `docs-failing` record after this poll, while it fails. */
  docsFailing?: DocsFailing
  /** Price clears not applied: too many for one poll (`refusesPriceClears`). */
  priceClearsRefused?: number
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

/** Stable reasoning provenance. A silent docs read must be stored, not dropped. */
function reasoningSourcePath(sources: unknown): string | null {
  if (typeof sources !== 'object' || sources === null) return null
  const path = (sources as ModelFactSources).reasoning?.path
  return typeof path === 'string' ? path : null
}

/**
 * A map the listing read from the model's own request schema wins; else the
 * provider-wide table.
 */
function requestMapFor(providerId: string, info: ModelInfo) {
  return (
    info.requestMap ??
    chatRequestMap(providerId, info.rawId, info.activity ?? null)
  )
}

/** The fields whose changes constitute a `model.updated` event. */
function comparable(
  providerId: string,
  info: ModelInfo,
): Record<string, unknown> {
  return {
    displayName: info.displayName ?? null,
    activity: info.activity ?? null,
    contextWindow: info.contextWindow ?? null,
    maxOutput: info.maxOutput ?? null,
    modalities: info.modalities ?? null,
    pricing: info.pricing ?? null,
    capabilities: info.capabilities ?? null,
    reasoning: info.reasoning ?? null,
    reasoningSource: reasoningSourcePath(info.factSources),
    serverTools: info.serverTools ?? null,
    requestMap: requestMapFor(providerId, info),
    aliases: storedAliases(info.aliases),
    schemaEndpointId: info.schemaEndpointId ?? null,
    deprecated: info.deprecated ?? false,
  }
}

type InputWalks = {
  walks: Map<string, SchemaWalk>
  properties: Map<string, Set<string>>
}

/** Key for the walk of one model's branch of a `model`-discriminated body. */
function modelWalkKey(endpointId: string, rawId: string): string {
  return `${endpointId}\n${rawId}`
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
    const meta = {
      derivation: rung,
      endpointId: publicId,
      sourceUrl: row.sourceUrl,
      sourceHash: row.sourceHash,
      fetchedAt: row.createdAt,
    }
    const walk = walkRequestSchema(parsed, meta)
    if (walk) walks.set(publicId, walk)
    for (const [rawId, branch] of modelBranchSchemas(parsed)) {
      const own = walkRequestSchema(branch, meta)
      if (own) walks.set(modelWalkKey(publicId, rawId), own)
    }
  }
  const perModel = new Set(provider.perModelSchemaFlags)
  if (perModel.size > 0) {
    for (const [id, walk] of walks) {
      walks.set(id, {
        ...walk,
        flags: walk.flags.filter((flag) => !perModel.has(flag)),
      })
    }
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

function pricingDerivation(sources: unknown): string | null {
  if (typeof sources !== 'object' || sources === null) return null
  const pricing = (sources as ModelFactSources).pricing
  return pricing?.derivation ?? null
}

function restorePriorPricing(
  next: ModelFactSources | null,
  previous: unknown,
): ModelFactSources | null {
  if (typeof previous !== 'object' || previous === null) return next
  const prior = (previous as ModelFactSources).pricing
  if (!prior) return next
  return { ...(next ?? {}), pricing: prior }
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
  const walk = bound
    ? (walks.get(modelWalkKey(bound, info.rawId)) ?? walks.get(bound) ?? null)
    : null
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

type StoredFact = Exclude<ModelFact, 'pricing'>

/** A stored row's facts in listing shape. With no row, every fact is empty. */
function storedFacts(
  row: typeof models.$inferSelect | undefined,
): Record<StoredFact, unknown> {
  return {
    displayName: row?.displayName ?? null,
    activity: row?.activity ?? null,
    contextWindow: row?.contextWindow ?? null,
    maxOutput: row?.maxOutput ?? null,
    modalities: row?.modalities ?? null,
    capabilities: row?.capabilities ?? null,
    reasoning: row?.reasoning ?? null,
    serverTools: row?.serverTools ?? null,
    requestMap: row?.requestMap ?? null,
    aliases: row?.aliases ?? null,
    schemaEndpointId: row?.schemaEndpointId ?? null,
  }
}

const SOURCED_FACTS = [
  'contextWindow',
  'maxOutput',
  'modalities',
  'capabilities',
  'reasoning',
  'serverTools',
] as const

/** The facts `enrichListed` fills from the bound request schema. */
const WALKED_FACTS = ['capabilities', 'modalities'] as const

/**
 * Apply `info.absent` (see `FactAbsence`) to every fact but pricing, which
 * the card path owns: `unavailable` takes the stored value and its source,
 * `cleared` takes none. It runs twice. Before the schema walks, so a row
 * whose docs failed binds, and is checked, against its stored endpoint.
 * Then for `WALKED_FACTS` alone after the walk, which would otherwise
 * refill a kept or cleared fact.
 */
function resolveAbsent(
  info: ModelInfo,
  existing: typeof models.$inferSelect | undefined,
  only?: ReadonlyArray<StoredFact>,
): ModelInfo {
  const absent = info.absent
  if (!absent) return info
  const stored = storedFacts(existing)
  const none = storedFacts(undefined)
  const next: ModelInfo = { ...info }
  for (const fact of only ?? (Object.keys(none) as Array<StoredFact>)) {
    const why = absent[fact]
    if (!why) continue
    Object.assign(next, {
      [fact]: (why === 'unavailable' ? stored : none)[fact],
    })
  }
  const sources: ModelFactSources = { ...info.factSources }
  const prior = (existing?.factSources ?? {}) as ModelFactSources
  for (const fact of SOURCED_FACTS) {
    const why = absent[fact]
    if (!why || (only && !only.includes(fact))) continue
    delete sources[fact]
    if (why === 'unavailable' && prior[fact]) {
      Object.assign(sources, { [fact]: prior[fact] })
    }
  }
  next.factSources = emptySources(sources) ? undefined : sources
  return next
}

/**
 * One poll may not clear most of a provider's prices. `cleared` is an
 * adapter's word that a price is gone, and an adapter that misreads a
 * reshaped listing would say it for every row at once. When a poll would
 * clear at least `PRICE_CLEARS_MIN` stored cards and more than
 * `PRICE_CLEARS_SHARE` of the priced rows it lists, none of its clears is
 * applied: the cards stay and the poll logs one failure. Fewer than the
 * minimum always passes, so a small provider can still lose every price.
 * The refusal repeats every poll until the adapter or this bound changes,
 * or the stale cards are nulled by hand in D1.
 */
const PRICE_CLEARS_MIN = 5
const PRICE_CLEARS_SHARE = 0.5

/** Stored cards this poll asks to clear, when that is too many to believe. */
function refusesPriceClears(
  listed: Array<ModelInfo>,
  existingById: Map<string, typeof models.$inferSelect>,
  providerId: string,
): { clears: number; priced: number } | null {
  const clears = listed.filter(
    (info) =>
      info.absent?.pricing === 'cleared' &&
      storedCardIsPrior(
        existingById.get(modelDbId(providerId, info.rawId))?.pricing,
      ),
  ).length
  if (clears < PRICE_CLEARS_MIN) return null
  // Of the rows this poll lists: a delisted row that still holds a card
  // must not make room for clearing every live one.
  const priced = listed.filter((info) =>
    storedCardIsPrior(
      existingById.get(modelDbId(providerId, info.rawId))?.pricing,
    ),
  ).length
  return clears > priced * PRICE_CLEARS_SHARE ? { clears, priced } : null
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
    failures: 0,
  }
  await ensureProviderRow(db, provider)
  await dropModelsDevSchemaVersions(db, provider.id)
  await nullModelsDevRateCards(db, provider.id)

  const listed = await provider.listModels(secrets, deps.kv)
  if (listed.skipped) {
    // Not an empty list. An empty list would also drop a later first-party
    // row the next time this adapter skips.
    outcome.skipped = listed.skipped
    outcome.removed = await deprecateFrozenModelsDevCatalog(
      db,
      provider.id,
      now,
    )
    return outcome
  }
  outcome.modelsSeen = listed.models.length
  // A docs source that failed does not fail the poll: its rows carry
  // `absent: unavailable` and keep what is stored. Every failing poll says
  // so again, here and in the outcome, so an outage never goes quiet.
  const docs = listed.docsFailures
  if (docs) {
    // Kept across polls (`docs-failing.ts`): when it began, how long.
    // The record describes the poll; it must never be what fails it.
    try {
      const failing = await recordDocsFailing(db, provider.id, docs, now)
      if (failing) outcome.docsFailing = failing
    } catch (error) {
      console.error(
        JSON.stringify({
          job: 'models-poll',
          providerId: provider.id,
          error: `docs-failing record not written: ${errorMessage(error)}`,
        }),
      )
    }
  }
  if (docs && docs.failed + docs.skipped > 0) {
    outcome.docsFailures = docs
    outcome.failures += docs.failed + docs.skipped
    const report = (error: string, source?: string) => {
      console.error(
        JSON.stringify({
          job: 'models-poll',
          providerId: provider.id,
          ...(source ? { docs: source } : {}),
          error,
        }),
      )
      noteIngest(ingestFailedEvent('models-poll', provider.id, error, source))
    }
    for (const { source, error } of docs.first) report(error, source)
    // The rest are a count: a whole docs host down is one line, not eighty.
    const more = docs.failed - docs.first.length
    if (more + docs.skipped > 0) {
      report(
        `docs: ${String(more)} more failed, ${String(docs.skipped)} not attempted after the failure budget`,
      )
    }
  }

  const existingRows = await db
    .select()
    .from(models)
    .where(eq(models.providerId, provider.id))
  const existingById = new Map(existingRows.map((m) => [m.id, m]))
  const listedModels = listed.models.map((info) =>
    resolveAbsent(info, existingById.get(modelDbId(provider.id, info.rawId))),
  )
  const { walks, properties } = await loadInputWalks(db, provider, listedModels)
  const refused = refusesPriceClears(listedModels, existingById, provider.id)
  if (refused) {
    const error = `refused to clear ${String(refused.clears)} of ${String(refused.priced)} stored prices in one poll`
    console.error(
      JSON.stringify({ job: 'models-poll', providerId: provider.id, error }),
    )
    noteIngest(ingestFailedEvent('models-poll', provider.id, error))
    outcome.priceClearsRefused = refused.clears
    outcome.failures++
  }
  const seenIds = new Set<string>()
  const identities: Array<UpstreamIdentityWrite> = []
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

  for (const listedModel of listedModels) {
    const raw =
      provider.bindSyncedRoutesOnly === true &&
      listedModel.schemaEndpointId &&
      !properties.has(listedModel.schemaEndpointId)
        ? { ...listedModel, schemaEndpointId: null }
        : listedModel
    const id = modelDbId(provider.id, raw.rawId)
    const existing = existingById.get(id)
    const enriched = resolveAbsent(
      enrichListed(provider, raw, walks),
      existing,
      WALKED_FACTS,
    )
    const bound = resolveSchemaEndpointId({
      providerId: provider.id,
      rawId: enriched.rawId,
      activity: enriched.activity ?? null,
      capabilities: enriched.capabilities,
      schemaEndpointId: enriched.schemaEndpointId,
    })
    const existingPricing = existing?.pricing
    // A models.dev card is not a prior. A docs-extracted card, and any
    // other provider source, still is.
    const hadStoredCard = storedCardIsPrior(existingPricing)
    const keepExtracted =
      raw.pricing == null &&
      pricingDerivation(existing?.factSources) === 'docs-extracted' &&
      !isModelsDevRateCard(existingPricing)
    // A refused clear is treated as a source that could not be read.
    const absentPricing =
      refused && raw.absent?.pricing === 'cleared'
        ? 'unavailable'
        : raw.absent?.pricing
    const incomingPricing =
      absentPricing || isModelsDevRateCard(enriched.pricing)
        ? null
        : enriched.pricing
    const incomingNull = incomingPricing == null
    const stored =
      absentPricing === 'unavailable' ||
      (absentPricing !== 'cleared' &&
        (keepExtracted || (incomingNull && hadStoredCard)))
        ? { card: parseStoredRateCard(existingPricing) }
        : await storeListedPricing(incomingPricing, {
            existing: existingPricing,
            requestProperties: bound
              ? (properties.get(bound) ?? new Set())
              : undefined,
            sourceUrl: listingSourceUrl(provider),
            now,
          })
    const decision = observePricingWrite({
      providerId: provider.id,
      rawId: enriched.rawId,
      incomingNull,
      hadStoredCard,
      keepExtracted,
      absent: absentPricing,
      refused: stored.refused,
    })
    for (const event of decision.events) noteIngest(event)
    outcome.failures += decision.failure
    if (!keepExtracted && stored.refused) {
      logRefusedCard(provider.id, enriched.rawId, stored.refused, hadStoredCard)
    }
    const card = decision.keepPrior
      ? parseStoredRateCard(existingPricing)
      : stored.card
    let factSources = reconcilePricingSource(enriched.factSources, card)
    if (decision.keepPrior) {
      factSources = restorePriorPricing(factSources, existing?.factSources)
    }
    const info: ModelInfo = {
      ...enriched,
      pricing: card,
      factSources: factSources ?? undefined,
    }
    if (seenIds.has(id)) continue // defensive: provider returned a dup
    seenIds.add(id)
    const identity = provider.upstreamModelIdentity?.(info.rawId) ?? null
    // Only changed evidence is written: most rows restate it every poll.
    if (!sameEvidence(existing, identity)) identities.push({ id, identity })

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
        reasoning: info.reasoning ?? null,
        serverTools: info.serverTools ?? null,
        requestMap: requestMapFor(provider.id, info),
        aliases: storedAliases(info.aliases),
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
      reasoning: existing.reasoning,
      reasoningSource: reasoningSourcePath(existing.factSources),
      serverTools: existing.serverTools,
      requestMap: existing.requestMap,
      aliases: storedAliases(existing.aliases),
      schemaEndpointId: existing.schemaEndpointId,
      deprecated: existing.deprecatedAt !== null,
    }
    const after = comparable(provider.id, {
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
        reasoning: info.reasoning ?? null,
        serverTools: info.serverTools ?? null,
        requestMap: requestMapFor(provider.id, info),
        aliases: storedAliases(info.aliases),
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
  await markModelsDevCatalogSettled(db, provider.id, now)
  await persistUpstreamIdentities(db, identities)

  return outcome
}

/** Poll every registered provider with per-provider failure isolation. */
export async function pollAllProviders(
  deps: SyncDeps,
  registry: ReadonlyArray<ProviderConfig> = providerRegistry,
): Promise<Array<PollOutcome>> {
  const outcomes: Array<PollOutcome> = []
  for (const provider of registry) {
    await runIngestScope(async () => {
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
        noteIngest(ingestFailedEvent('models-poll', provider.id, message))
        outcomes.push({
          providerId: provider.id,
          modelsSeen: 0,
          added: 0,
          removed: 0,
          updated: 0,
          backdated: 0,
          failures: 1,
          error: message,
        })
      } finally {
        await captureIngestEvents(deps.secrets.POSTHOG_PROJECT_KEY)
      }
    })
  }
  // Links span providers, so resolve them once per run, outside any one
  // provider's outcome: a failure here must not read as every poll failing.
  await runIngestScope(async () => {
    try {
      await reconcileSameAs(
        deps.db,
        deps.now?.() ?? Math.floor(Date.now() / 1000),
      )
    } catch (error) {
      const message = errorMessage(error)
      console.error(
        JSON.stringify({ job: 'same-as-reconcile', error: message }),
      )
      noteIngest(ingestFailedEvent('same-as-reconcile', '*', message))
    } finally {
      await captureIngestEvents(deps.secrets.POSTHOG_PROJECT_KEY)
    }
  })
  return outcomes
}
