import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineProject } from 'vitest/config'

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
      },
    }),
  ],
  test: {
    name: 'workers',
    include: ['src/**/*.worker.test.ts'],
  },
})
