import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

import { oauthAuthorizationServer } from '#/server/auth-discovery.ts'

export const Route = createFileRoute('/.well-known/oauth-authorization-server')(
  {
    server: {
      handlers: {
        GET: () => Response.json(oauthAuthorizationServer(env.BETTER_AUTH_URL)),
      },
    },
  },
)
