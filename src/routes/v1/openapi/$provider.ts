import { createFileRoute } from '@tanstack/react-router'
import { env, waitUntil } from 'cloudflare:workers'

import { getDb } from '#/db/index.ts'
import { jsonError } from '#/server/admin.ts'
import { swr } from '#/server/cache.ts'
import { cachedJson } from '#/server/http-cache.ts'
import { assembleProviderOpenApi } from '#/server/provider-openapi.ts'

export const Route = createFileRoute('/v1/openapi/$provider')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const url = new URL(request.url)
        const model = url.searchParams.get('model') ?? undefined
        const activity = url.searchParams.get('activity') ?? undefined
        const db = getDb(env)
        const result = await swr(
          { db, kv: env.SCHEMA_CACHE, waitUntil },
          `openapi:${params.provider}:${activity ?? ''}:${model ?? ''}`,
          () =>
            assembleProviderOpenApi(db, params.provider, { model, activity }),
          { staleTime: 300 },
        )
        if (!result.value.ok) {
          return jsonError(
            result.value.status,
            result.value.code,
            result.value.message,
          )
        }
        return cachedJson(request, result.value.document, {
          etag: result.value.etag,
          fetchedAt: result.fetchedAt,
          staleAt: result.staleAt,
          contentType: 'application/openapi+json',
        })
      },
    },
  },
})
