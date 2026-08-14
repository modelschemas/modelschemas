import { createFileRoute } from '@tanstack/react-router'
import { env, waitUntil } from 'cloudflare:workers'

import { getDb } from '#/db/index.ts'
import { swr } from '#/server/cache.ts'
import { cachedJson } from '#/server/http-cache.ts'
import { getSystemSchemaIndex } from '#/server/schemas-api.ts'

export const Route = createFileRoute('/v1/schemas/')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const db = getDb(env)
        const result = await swr(
          { db, kv: env.SCHEMA_CACHE, waitUntil },
          'schema-index:all',
          () => getSystemSchemaIndex(db),
          { staleTime: 300 },
        )
        return cachedJson(request, result.value, {
          fetchedAt: result.fetchedAt,
          staleAt: result.staleAt,
        })
      },
    },
  },
})
