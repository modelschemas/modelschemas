import { defineConfig } from 'vitest/config'

// Two projects: plain unit tests run in node; *.worker.test.ts files run in
// workerd via @cloudflare/vitest-plugin with real KV/D1 bindings (the
// @cloudflare/vite-plugin is incompatible with vitest, see vite.config.ts).
export default defineConfig({
  test: {
    // better-auth's withSpan telemetry leaves a floating rejection for
    // APIErrors it already surfaced as 4xx responses (invalid OTP, duplicate
    // email). Ignore exactly that class; everything else still fails runs.
    onUnhandledError(error) {
      if ((error as { name?: string }).name === 'APIError') return false
    },
    projects: ['./vitest.unit.config.ts', './vitest.workers.config.ts'],
  },
})
