import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

import { getDb } from '#/db/index.ts'
import { jsonError } from '#/server/admin.ts'
import { knownProviderIds, listProviderModels } from '#/server/catalog.ts'
import { cachedJson } from '#/server/http-cache.ts'

export const Route = createFileRoute('/v1/providers/$provider/models')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const db = getDb(env)
        const body = await listProviderModels(db, params.provider)
        if (!body) {
          const valid = (await knownProviderIds(db)).join(', ')
          return jsonError(
            404,
            'unknown_provider',
            `Unknown provider '${params.provider}'. Valid providers: ${valid}.`,
          )
        }
        const now = Math.floor(Date.now() / 1000)
        return cachedJson(request, body, { fetchedAt: now, staleAt: now + 60 })
      },
    },
  },
})
