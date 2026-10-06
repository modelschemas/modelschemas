import { eq, sql } from 'drizzle-orm'

import type { Db } from '#/db/index.ts'
import { changes, models } from '#/db/schema.ts'
import { stableStringify } from '#/server/kv.ts'
import type { UpstreamModelIdentity } from '#/server/providers/types.ts'

export interface UpstreamIdentityWrite {
  id: string
  identity: UpstreamModelIdentity | null
}

/** Whether a row's stored evidence already says what the provider states. */
export function sameEvidence(
  row: typeof models.$inferSelect | undefined,
  identity: UpstreamModelIdentity | null,
): boolean {
  return (
    (row?.upstreamProvider ?? null) === (identity?.providerNamespace ?? null) &&
    (row?.upstreamRawId ?? null) === (identity?.rawId ?? null) &&
    stableStringify(row?.upstreamSource ?? null) ===
      stableStringify(identity?.source ?? null)
  )
}

/** Write identity evidence in batches; reconcileSameAs owns the link. */
export async function persistUpstreamIdentities(
  db: Db,
  identities: readonly UpstreamIdentityWrite[],
): Promise<void> {
  for (let i = 0; i < identities.length; i += 30) {
    const statements = identities.slice(i, i + 30).map(({ id, identity }) =>
      db
        .update(models)
        .set({
          upstreamProvider: identity?.providerNamespace ?? null,
          upstreamRawId: identity?.rawId ?? null,
          upstreamSource: identity?.source ?? null,
        })
        .where(eq(models.id, id)),
    )
    const [first, ...rest] = statements
    if (first) await db.batch([first, ...rest])
  }
}

/**
 * Resolve stored evidence into links, catalog-wide. The stated namespace is
 * a provider id, or a name exactly one provider claims in
 * `provider_model_namespaces`. Within that provider an exact id wins, then a documented alias, then the same two with
 * dots read as hyphens (gateways write `claude-opus-4.5` for Anthropic's
 * `claude-opus-4-5`). More than one match at the winning tier is ambiguous:
 * no link. Evidence is never touched here, so a target that arrives later
 * links without re-polling the reseller.
 */
export async function reconcileSameAs(db: Db, now: number): Promise<void> {
  const diffs = await db.all<{
    id: string
    provider_id: string
    before: string | null
    after: string | null
  }>(sql`
    WITH sources AS (
      SELECT id, upstream_raw_id AS raw_id,
        coalesce(
          (SELECT id FROM providers WHERE id = models.upstream_provider),
          (SELECT CASE WHEN count(*) = 1 THEN max(provider_id) END
            FROM provider_model_namespaces
            WHERE namespace = models.upstream_provider)
        ) AS provider_id
      FROM models WHERE upstream_provider IS NOT NULL
    ), candidates AS (
      SELECT source.id AS source_id, target.id AS target_id,
        CASE
          WHEN target.raw_id = source.raw_id THEN 0
          WHEN EXISTS (
            SELECT 1 FROM json_each(target.aliases)
            WHERE value = source.raw_id
          ) THEN 1
          ELSE 2
        END AS tier
      FROM sources source
      JOIN models target ON target.provider_id = source.provider_id
        AND target.id != source.id
      WHERE target.raw_id IN (
          source.raw_id, replace(source.raw_id, '.', '-')
        ) OR EXISTS (
          SELECT 1 FROM json_each(target.aliases) WHERE value IN (
            source.raw_id, replace(source.raw_id, '.', '-')
          )
        )
    ), resolved AS (
      SELECT source_id,
        CASE WHEN count(*) = 1 THEN max(target_id) END AS target_id
      FROM (
        SELECT *, min(tier) OVER (PARTITION BY source_id) AS best
        FROM candidates
      )
      WHERE tier = best
      GROUP BY source_id
    )
    SELECT models.id, models.provider_id,
      models.same_as_model_id AS before, resolved.target_id AS after
    FROM models LEFT JOIN resolved ON resolved.source_id = models.id
    WHERE (models.upstream_provider IS NOT NULL
        OR models.same_as_model_id IS NOT NULL)
      AND models.same_as_model_id IS NOT resolved.target_id
  `)

  // A link and its change row commit together: a failed chunk leaves its
  // rows still differing, so the next run emits them. Ten rows keep the
  // insert under D1's 100-bound-parameter limit.
  for (let i = 0; i < diffs.length; i += 10) {
    const chunk = diffs.slice(i, i + 10)
    await db.batch([
      db.insert(changes).values(
        chunk.map((row) => ({
          id: crypto.randomUUID(),
          type: 'model.updated' as const,
          providerId: row.provider_id,
          subjectId: row.id,
          summary: 'Upstream model link updated',
          payload: {
            before: { sameAsModelId: row.before },
            after: { sameAsModelId: row.after },
          },
          createdAt: now,
        })),
      ),
      ...chunk.map((row) =>
        db
          .update(models)
          .set({ sameAsModelId: row.after })
          .where(eq(models.id, row.id)),
      ),
    ])
  }
}
