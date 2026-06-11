import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

import { apiCatalog, LINKSET_CONTENT_TYPE } from '#/server/discovery.ts'

export const Route = createFileRoute('/.well-known/api-catalog')({
  server: {
    handlers: {
      GET: () =>
        new Response(JSON.stringify(apiCatalog(env.BETTER_AUTH_URL)), {
          headers: { 'Content-Type': LINKSET_CONTENT_TYPE },
        }),
    },
  },
})
