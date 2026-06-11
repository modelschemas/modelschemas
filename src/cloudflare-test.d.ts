// Minimal typing for the `cloudflare:test` module provided at runtime by
// @cloudflare/vitest-pool-workers. Binding types come from the generated
// worker-configuration.d.ts globals (wrangler types).
declare module 'cloudflare:test' {
  import type { D1Migration } from '@cloudflare/vitest-pool-workers'

  interface ProvidedEnv {
    SCHEMA_CACHE: KVNamespace
    DB: D1Database
    TEST_MIGRATIONS: Array<D1Migration>
  }

  export const env: ProvidedEnv

  export function applyD1Migrations(
    db: D1Database,
    migrations: Array<D1Migration>,
    migrationsTableName?: string,
  ): Promise<void>
}
