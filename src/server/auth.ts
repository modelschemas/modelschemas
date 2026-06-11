import { env } from 'cloudflare:workers'
import { tanstackStartCookies } from 'better-auth/tanstack-start'

import { getDb } from '#/db/index.ts'
import { createAuth } from '#/lib/auth.ts'
import type { Auth } from '#/lib/auth.ts'

let instance: Auth | undefined

// Lazy: betterAuth() performs random-value generation at construction, which
// workerd forbids in module/global scope in the built worker — build the
// instance on first use inside a request handler instead.
export function getAuth(): Auth {
  instance ??= createAuth(getDb(env), {
    secret: env.BETTER_AUTH_SECRET,
    baseUrl: env.BETTER_AUTH_URL,
    // Last in the plugin list (better-auth requirement for cookie handling).
    extraPlugins: [tanstackStartCookies()],
  })
  return instance
}
