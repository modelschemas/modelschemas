import { applyD1Migrations, env } from 'cloudflare:test'

// Runs once per workers-pool test isolate so every *.worker.test.ts sees a
// fully migrated D1 database.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
