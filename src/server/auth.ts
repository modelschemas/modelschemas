import { env } from 'cloudflare:workers'
import { tanstackStartCookies } from 'better-auth/tanstack-start'

import { getDb } from '#/db/index.ts'
import { createAuth } from '#/lib/auth.ts'

export const auth = createAuth(getDb(env), {
  secret: env.BETTER_AUTH_SECRET,
  // Last in the plugin list (better-auth requirement for cookie handling).
  extraPlugins: [tanstackStartCookies()],
})
