import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

import { authMd } from '#/server/auth-discovery.ts'

export const Route = createFileRoute('/auth.md')({
  server: {
    handlers: {
      GET: () =>
        new Response(authMd(env.BETTER_AUTH_URL), {
          headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
        }),
    },
  },
})
