import { eq, sql } from 'drizzle-orm'

import type { Db } from '#/db/index.ts'
import { changes, models } from '#/db/schema.ts'
import { stableStringify } from '#/server/kv.ts'
import type {
  ModelFactSources,
  ProviderConfig,
  UpstreamModelIdentity,
} from '#/server/providers/types.ts'

export interface UpstreamIdentityWrite {
  id: string
  identity: UpstreamModelIdentity | null
}

/** Keep the resolved link's evidence intact until reconciliation replaces it. */
export function retainSameAsSource(next: ModelFactSources | null | undefined) {
  const { sameAs: _linkSource, ...facts } = next ?? {}
  const serialized = stableStringify(facts)
  return sql`CASE
    WHEN ${models.sameAsModelId} IS NOT NULL THEN
      json_set(${serialized}, '$.sameAs', json_extract(${models.factSources}, '$.sameAs'))
    ELSE nullif(${serialized}, '{}')
  END`
}

/** Write pending identity evidence in batches; reconciliation owns the link. */
export async function persistUpstreamIdentities(
  db: Db,
  identities: readonly UpstreamIdentityWrite[],
): Promise<void> {
  for (let i = 0; i < identities.length; i += 30) {
    const statements = identities.slice(i, i + 30).map(({ id, identity }) => {
      const provider = identity?.providerNamespace ?? null
      const rawId = identity?.rawId ?? null
      const source = stableStringify(identity?.source ?? null)
      return db.update(models).set({
        upstreamProvider: provider,
        upstreamRawId: rawId,
        upstreamSource: identity ? sql`json(${source})` : null,
      }).where(sql`
        ${models.id} = ${id} AND (
          ${models.upstreamProvider} IS NOT ${provider}
          OR ${models.upstreamRawId} IS NOT ${rawId}
          OR coalesce(${models.upstreamSource}, 'null') != ${source}
        )
      `)
    })
    const [first, ...rest] = statements
    if (first) await db.batch([first, ...rest])
  }
}

/**
 * A skipped listing cannot supply new listing evidence. An adapter can still
 * interpret stored ids using a documented upstream routing format.
 */
export async function refreshDocumentedUpstreamIdentities(
  db: Db,
  provider: ProviderConfig,
): Promise<void> {
  const identify = provider.upstreamModelIdentity
  if (!identify) return
  const rows = await db
    .select({ id: models.id, rawId: models.rawId })
    .from(models)
    .where(eq(models.providerId, provider.id))
  const identities: Array<UpstreamIdentityWrite> = []
  for (const row of rows) {
    const identity = identify(row.rawId)
    if (
      !identity ||
      !['docs-derived', 'docs-extracted'].includes(identity.source.derivation)
    )
      continue
    identities.push({ id: row.id, identity })
  }
  await persistUpstreamIdentities(db, identities)
}

/**
 * Resolve native evidence into foreign keys after ingestion. No provider or
 * model names live here: exact provider ids and catalog namespace aliases
 * identify the native provider, then exact ids precede documented aliases.
 * Missing or ambiguous targets clear the link while retaining the evidence.
 */
export async function reconcileSameAs(db: Db, now: number): Promise<void> {
  const changed = await db.all<{
    id: string
    provider_id: string
    same_as_model_id: string | null
  }>(sql`
    WITH upstream_providers AS (
      SELECT source.id AS source_id, source.upstream_raw_id AS raw_id,
        coalesce(
          (SELECT id FROM providers WHERE id = source.upstream_provider),
          (SELECT CASE WHEN count(*) = 1 THEN max(provider_id) END FROM provider_model_namespaces
            WHERE namespace = source.upstream_provider)
        ) AS provider_id
      FROM models source
      WHERE source.upstream_provider IS NOT NULL
        AND json_extract(source.upstream_source, '$.derivation') IS NOT NULL
    ), candidates AS (
      SELECT upstream.source_id, target.id AS target_id,
        target.raw_id = upstream.raw_id AS exact
      FROM upstream_providers upstream
      JOIN models target ON target.provider_id = upstream.provider_id
      WHERE target.id != upstream.source_id
        AND (target.raw_id = upstream.raw_id OR EXISTS (
          SELECT 1 FROM json_each(target.aliases) WHERE value = upstream.raw_id
        ))
    ), resolved AS (
      SELECT source_id,
        CASE
          WHEN sum(exact) = 1 THEN max(CASE WHEN exact THEN target_id END)
          WHEN sum(exact) = 0 AND count(*) = 1 THEN max(target_id)
          ELSE NULL
        END AS target_id
      FROM candidates GROUP BY source_id
    )
    UPDATE models SET
      same_as_model_id = (SELECT target_id FROM resolved WHERE source_id = models.id),
      fact_sources = CASE
        WHEN (SELECT target_id FROM resolved WHERE source_id = models.id) IS NOT NULL
          THEN json_set(coalesce(fact_sources, '{}'), '$.sameAs', json(upstream_source))
        ELSE nullif(json_remove(fact_sources, '$.sameAs'), '{}')
      END
    WHERE (upstream_provider IS NOT NULL OR same_as_model_id IS NOT NULL
        OR json_extract(fact_sources, '$.sameAs') IS NOT NULL)
      AND (
        same_as_model_id IS NOT (SELECT target_id FROM resolved WHERE source_id = models.id)
        OR json_extract(fact_sources, '$.sameAs') IS NOT (
          CASE WHEN (SELECT target_id FROM resolved WHERE source_id = models.id) IS NOT NULL
            THEN json(upstream_source) END
        )
      )
    RETURNING id, provider_id, same_as_model_id
  `)

  for (let i = 0; i < changed.length; i += 10) {
    await db.insert(changes).values(
      changed.slice(i, i + 10).map((row) => ({
        id: crypto.randomUUID(),
        type: 'model.updated' as const,
        providerId: row.provider_id,
        subjectId: row.id,
        summary: 'Upstream model link updated',
        payload: { sameAsModelId: row.same_as_model_id },
        createdAt: now,
      })),
    )
  }
}
