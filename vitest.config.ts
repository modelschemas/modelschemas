import { defineConfig } from 'vitest/config'

// Two projects: plain unit tests run in node; *.worker.test.ts files run in
// workerd via @cloudflare/vitest-pool-workers with real KV/D1 bindings (the
// @cloudflare/vite-plugin is incompatible with vitest, see vite.config.ts).
export default defineConfig({
  test: {
    projects: ['./vitest.unit.config.ts', './vitest.workers.config.ts'],
  },
})
