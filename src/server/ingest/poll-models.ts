/**
 * Model poller (PLAN.md task 2.4) — the fast 15-minute tier: per provider,
 * list currently served models, diff against D1, write
 * model.added/removed/updated changes, bump lastSeenAt.
 */
import { eq, inArray } from 'drizzle-orm'

import { changes, models, providers } from '#/db/schema.ts'
import { errorMessage } from '#/server/errors.ts'
import { stableStringify } from '#/server/kv.ts'
import type { ModelInfo, ProviderConfig } from '#/server/providers/types.ts'
import { providerRegistry } from '#/server/providers/index.ts'
import type { SyncDeps } from './sync.ts'

export interface PollOutcome {
  providerId: string
  modelsSeen: number
  added: number
  removed: number
  updated: number
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
    deprecated: info.deprecated ?? false,
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
  }

  const listed = await provider.listModels(secrets)
  if (listed.skipped) {
    outcome.skipped = listed.skipped
    return outcome
  }
  outcome.modelsSeen = listed.models.length

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

  for (const info of listed.models) {
    const id = modelDbId(provider.id, info.rawId)
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
        firstSeenAt: now,
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
      deprecated: existing.deprecatedAt !== null,
    }
    const after = comparable(info)
    const dirty = stableStringify(before) !== stableStringify(after)

    if (!dirty) {
      cleanIds.push(id)
      continue
    }

    await db
      .update(models)
      .set({
        lastSeenAt: now,
        displayName: info.displayName ?? null,
        activity: info.activity ?? null,
        contextWindow: info.contextWindow ?? null,
        maxOutput: info.maxOutput ?? null,
        modalities: info.modalities ?? null,
        pricing: info.pricing ?? null,
        capabilities: info.capabilities ?? null,
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
        error: message,
      })
    }
  }
  return outcomes
}
