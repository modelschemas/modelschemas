import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

import { getDb } from '#/db/index.ts'
import { isAdminRequest, jsonError } from '#/server/admin.ts'
import { syncProvider } from '#/server/ingest/sync.ts'
import { getProvider, providerRegistry } from '#/server/providers/index.ts'

export const Route = createFileRoute('/v1/admin/sync/$provider')({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        if (!isAdminRequest(request, env.ADMIN_KEY)) {
          return jsonError(
            401,
            'unauthorized',
            'Provide the admin key via X-Admin-Key or Authorization: Bearer.',
          )
        }
        const provider = getProvider(params.provider)
        if (!provider) {
          const valid = providerRegistry.map((p) => p.id).join(', ')
          return jsonError(
            404,
            'unknown_provider',
            `Unknown provider '${params.provider}'. Valid providers: ${valid}.`,
          )
        }
        try {
          const outcome = await syncProvider(
            { db: getDb(env), kv: env.SCHEMA_CACHE, secrets: env },
            provider,
          )
          return Response.json({ outcome })
        } catch (error) {
          return jsonError(
            502,
            'sync_failed',
            error instanceof Error ? error.message : String(error),
          )
        }
      },
    },
  },
})
