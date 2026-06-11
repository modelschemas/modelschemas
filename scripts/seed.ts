// Seeds the providers table. Local D1 by default; pass --remote to target
// production: `bun run seed` / `bun run seed -- --remote`.
//
// Goes through `wrangler d1 execute` (instead of a drizzle client) so the
// script works against wrangler's local sqlite state without a node sqlite
// driver dependency.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { providerSeeds } from '../src/db/seed-providers.ts'

function sqlLiteral(value: string | null | undefined): string {
  if (value == null) return 'NULL'
  return `'${value.replaceAll("'", "''")}'`
}

// Idempotent upsert: refreshes the seeded config columns, preserves runtime
// state (last_polled_at, last_synced_at, status).
const statements = providerSeeds.map(
  (
    p,
  ) => `INSERT INTO providers (id, display_name, spec_source_url, models_endpoint, auth_env_var)
VALUES (${sqlLiteral(p.id)}, ${sqlLiteral(p.displayName)}, ${sqlLiteral(p.specSourceUrl)}, ${sqlLiteral(p.modelsEndpoint)}, ${sqlLiteral(p.authEnvVar)})
ON CONFLICT(id) DO UPDATE SET
  display_name = excluded.display_name,
  spec_source_url = excluded.spec_source_url,
  models_endpoint = excluded.models_endpoint,
  auth_env_var = excluded.auth_env_var;`,
)

const sqlFile = join(
  mkdtempSync(join(tmpdir(), 'modelschemas-seed-')),
  'seed.sql',
)
writeFileSync(sqlFile, statements.join('\n\n') + '\n')

const target = process.argv.includes('--remote') ? '--remote' : '--local'
const result = spawnSync(
  'bunx',
  ['wrangler', 'd1', 'execute', 'DB', target, '--file', sqlFile],
  { stdio: 'inherit' },
)

if (result.status !== 0) {
  console.error(`seed failed (wrangler exit ${String(result.status)})`)
  process.exit(result.status ?? 1)
}
console.log(`seeded ${String(providerSeeds.length)} providers (${target})`)
