/**
 * The served model row's shape version (issue #412). `hash` is the
 * description-free hash of the row schemas in openapi.ts; row-shape.test.ts
 * fails when they change and this record does not. On a change: bump
 * `version`, set `hash` to the value the test prints, rewrite `notes`, and
 * add a changeset for @modelschemas/client. The models-poll cron then
 * writes a `catalog.shape_changed` row to /v1/changes.
 */
import { desc, eq } from 'drizzle-orm'

import type { Db } from '#/db/index.ts'
import { changes, providers } from '#/db/schema.ts'
import { openApiDocument } from '#/server/openapi.ts'

export const MODEL_ROW_SHAPE = {
  version: 1,
  hash: '691a63b1df6de072adbdf78f8261bc7fc6857b61058295be54b319b3d0e7d557',
  notes:
    'First versioned row shape. capabilities is a flag map (Record<string, boolean>, a missing key is unknown); provider listing objects, ElevenLabs canDo* flags among them, are in providerMetadata; every row field is typed in openapi.json.',
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
 * Writes one `catalog.shape_changed` row per provider when the latest one
 * names a different hash (or none exists). Returns the rows written.
 */
export async function recordRowShape(
  db: Db,
  now = Math.floor(Date.now() / 1000),
  shape: { version: number; hash: string; notes: string } = MODEL_ROW_SHAPE,
): Promise<number> {
  const [latest] = await db
    .select({ payload: changes.payload })
    .from(changes)
    .where(eq(changes.type, 'catalog.shape_changed'))
    .orderBy(desc(changes.createdAt))
    .limit(1)
  const previousHash =
    (latest?.payload as { contentHash?: string } | null | undefined)
      ?.contentHash ?? null
  if (previousHash === shape.hash) return 0
  const ids = await db.select({ id: providers.id }).from(providers)
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
