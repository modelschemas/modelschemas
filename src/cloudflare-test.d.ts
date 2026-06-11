// Minimal typing for the `cloudflare:test` module provided at runtime by
// @cloudflare/vitest-pool-workers. Declared locally (instead of adding the
// package to tsconfig `types`) so Workers runtime globals don't leak into —
// and conflict with — the DOM-flavoured app tsconfig.
declare module 'cloudflare:test' {
  import type { D1Database, KVNamespace } from '@cloudflare/workers-types'

  interface ProvidedEnv {
    SCHEMA_CACHE: KVNamespace
    DB: D1Database
  }

  export const env: ProvidedEnv
}
