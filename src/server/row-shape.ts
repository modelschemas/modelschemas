/**
 * The served model row's shape version (issue #412). `hash` is the
 * description-free hash of the row schemas in openapi.ts; row-shape.test.ts
 * fails when they change and this record does not. On a change: bump
 * `version`, set `hash` to the value the test prints, rewrite `notes`, and
 * add a changeset for @modelschemas/client. The models-poll cron then
 * writes a `catalog.shape_changed` row to /v1/changes.
 */
import { and, desc, eq, ne, sql } from 'drizzle-orm'

import type { Db } from '#/db/index.ts'
import { changes, providers } from '#/db/schema.ts'
import { openApiDocument } from '#/server/openapi.ts'

export const MODEL_ROW_SHAPE = {
  version: 6,
  hash: '6bcd64247124d2ae2a7cf021fc43e3fb1386df0d3299c31aeed38ba6ad5f4216',
  notes:
    'pricing and PricingRange.routes[].card: RateCard now types its price (RateCardPrice), tables (RateCardTable) and inputs (a union by kind) instead of leaving them open. reasoning is the ModelReasoning component; requestMap.thinking.off is an object or null. Cards and rows served are unchanged (issue #494).',
} as const

/** Every component schema a /v1 model row response is built from. */
const ROW_SCHEMA_ROOTS = [
  'Model',
  'ExportModel',
  'ModelDetail',
  'ModelList',
  'ProviderModelList',
]

type Json = null | boolean | number | string | Array<Json> | JsonObject
interface JsonObject {
  [key: string]: Json
}

// Descriptions are prose: rewording one is not a shape change.
function canonical(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  const entries = Object.entries(value)
    .filter(([key]) => key !== 'description')
    .sort(([a], [b]) => (a < b ? -1 : 1))
  return `{${entries.map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`).join(',')}}`
}

/** sha256 over the row schemas and every schema they reference. */
export async function modelRowShapeHash(
  schemas: Record<string, Json> = openApiDocument.components
    .schemas as unknown as Record<string, Json>,
): Promise<string> {
  const closure = new Map<string, Json>()
  const visit = (name: string) => {
    if (closure.has(name)) return
    const schema = schemas[name]
    if (schema === undefined) throw new Error(`row shape: no schema ${name}`)
    closure.set(name, schema)
    for (const match of canonical(schema).matchAll(
      /"#\/components\/schemas\/([^"]+)"/g,
    ))
      visit(match[1] as string)
  }
  ROW_SCHEMA_ROOTS.forEach(visit)
  const body = canonical(Object.fromEntries(closure))
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(body),
  )
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Writes a `catalog.shape_changed` row for each provider that has none for
 * the current hash: every provider when the shape moves, and a provider
 * added later on its first poll. Returns the rows written. Rows of one
 * announcement share `payload.contentHash`; dedupe on it when reading
 * across providers.
 */
export async function recordRowShape(
  db: Db,
  now = Math.floor(Date.now() / 1000),
  shape: { version: number; hash: string; notes: string } = MODEL_ROW_SHAPE,
): Promise<number> {
  const hashOf = sql`json_extract(${changes.payload}, '$.contentHash')`
  const isShape = eq(changes.type, 'catalog.shape_changed')
  const announced = new Set(
    (
      await db
        .selectDistinct({ providerId: changes.providerId })
        .from(changes)
        .where(and(isShape, eq(hashOf, shape.hash)))
    ).map((row) => row.providerId),
  )
  const ids = (await db.select({ id: providers.id }).from(providers)).filter(
    ({ id }) => !announced.has(id),
  )
  if (ids.length === 0) return 0
  const [previous] = await db
    .select({ hash: hashOf })
    .from(changes)
    .where(and(isShape, ne(hashOf, shape.hash)))
    .orderBy(desc(changes.createdAt))
    .limit(1)
  const previousHash = typeof previous?.hash === 'string' ? previous.hash : null
  const rows = ids.map(({ id }) => ({
    id: crypto.randomUUID(),
    type: 'catalog.shape_changed' as const,
    providerId: id,
    subjectId: 'model-row',
    summary: `Model row shape v${String(shape.version)}`,
    payload: {
      version: shape.version,
      contentHash: shape.hash,
      previousHash,
      notes: shape.notes,
    },
    createdAt: now,
  }))
  // Ten rows keep each insert under D1's 100-bound-parameter limit; one
  // batch commits them all or none, so a failure retries next poll.
  const inserts = []
  for (let i = 0; i < rows.length; i += 10) {
    inserts.push(db.insert(changes).values(rows.slice(i, i + 10)))
  }
  const [first, ...rest] = inserts
  if (first) await db.batch([first, ...rest])
  return rows.length
}
