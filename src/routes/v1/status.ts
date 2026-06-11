import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

import { getDb } from '#/db/index.ts'
import { getServiceStatus } from '#/server/status.ts'

export const Route = createFileRoute('/v1/status')({
  server: {
    handlers: {
      GET: async () => Response.json(await getServiceStatus(getDb(env))),
    },
  },
})
