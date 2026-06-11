import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

import { oauthProtectedResource } from '#/server/auth-discovery.ts'

export const Route = createFileRoute('/.well-known/oauth-protected-resource')({
  server: {
    handlers: {
      GET: () => Response.json(oauthProtectedResource(env.BETTER_AUTH_URL)),
    },
  },
})
