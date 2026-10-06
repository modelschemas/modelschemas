import { createFileRoute } from '@tanstack/react-router'
import { env, waitUntil } from 'cloudflare:workers'

import { getDb } from '#/db/index.ts'
import { listProvidersCatalog } from '#/server/catalog.ts'
import { cachedJson } from '#/server/http-cache.ts'

export const Route = createFileRoute('/v1/providers/')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const now = Math.floor(Date.now() / 1000)
        const db = getDb(env)
        const body = await listProvidersCatalog(db, {
          db,
          kv: env.SCHEMA_CACHE,
          waitUntil,
        })
        return cachedJson(request, body, { fetchedAt: now, staleAt: now + 60 })
      },
    },
  },
})
