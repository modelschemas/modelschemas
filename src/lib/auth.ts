import { betterAuth } from 'better-auth'
import { bearer } from 'better-auth/plugins'
import { apiKey } from '@better-auth/api-key'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { agentAuth } from '@better-auth/agent-auth'
import type { BetterAuthPlugin } from 'better-auth'

import type { Db } from '#/db/index.ts'
import * as schema from '#/db/schema.ts'

// Factory rather than a singleton: the D1-backed db only exists per-request
// in Workers. The runtime instance lives in src/server/auth.ts; the better-auth
// CLI loads this factory through scripts/better-auth-config.ts instead, so this
// file must not import `cloudflare:workers` — and must not import
// `better-auth/tanstack-start` either (its vite-resolved subpath imports break
// outside the TanStack build; the runtime passes it via `extraPlugins`).
export function createAuth(
  db: Db,
  options?: { secret?: string; extraPlugins?: BetterAuthPlugin[] },
) {
  return betterAuth({
    database: drizzleAdapter(db, { provider: 'sqlite', schema }),
    secret: options?.secret,
    // Email/password backs delegated-mode approvals and the later dashboard.
    emailAndPassword: {
      enabled: true,
    },
    plugins: [
      agentAuth({
        providerName: 'modelschemas',
        providerDescription:
          'Live AI model schema service: per-endpoint request/response JSON Schemas and model metadata for monitored providers.',
        modes: ['autonomous', 'delegated'],
        // Capabilities are declared in Phase 5 (task 5.1), derived from our
        // own OpenAPI document.
        capabilities: [],
      }),
      apiKey(),
      bearer(),
      ...(options?.extraPlugins ?? []),
    ],
  })
}

export type Auth = ReturnType<typeof createAuth>
