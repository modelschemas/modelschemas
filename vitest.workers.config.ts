import {
  cloudflareTest,
  readD1Migrations,
} from '@cloudflare/vitest-pool-workers'
import { defineProject } from 'vitest/config'

const migrations = await readD1Migrations('./drizzle')

export default defineProject({
  plugins: [
    cloudflareTest({
      miniflare: {
        // Mirrors wrangler.jsonc (compatibility + bindings); kept inline
        // because pointing the pool at wrangler.jsonc would make it load the
        // full TanStack Start worker via `main`.
        compatibilityDate: '2025-09-02',
        compatibilityFlags: ['nodejs_compat'],
        kvNamespaces: ['SCHEMA_CACHE'],
        d1Databases: ['DB'],
        bindings: { TEST_MIGRATIONS: migrations },
      },
    }),
  ],
  test: {
    name: 'workers',
    include: ['src/**/*.worker.test.ts'],
    setupFiles: ['./src/test/apply-migrations.ts'],
  },
})
