import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

import { getDb } from '#/db/index.ts'
import { jsonError } from '#/server/admin.ts'
import { getModelDetail, knownProviderIds } from '#/server/catalog.ts'
import { cachedJson } from '#/server/http-cache.ts'

export const Route = createFileRoute('/v1/models/$provider/$modelId')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const db = getDb(env)
        const model = await getModelDetail(db, params.provider, params.modelId)
        if (!model) {
          const providers = await knownProviderIds(db)
          const hint = providers.includes(params.provider)
            ? `Try GET /v1/providers/${params.provider}/models for valid ids.`
            : `Unknown provider too — valid providers: ${providers.join(', ')}.`
          return jsonError(
            404,
            'unknown_model',
            `Unknown model '${params.modelId}' for provider '${params.provider}'. ${hint}`,
          )
        }
        const now = Math.floor(Date.now() / 1000)
        return cachedJson(request, model, { fetchedAt: now, staleAt: now + 60 })
      },
    },
  },
})
