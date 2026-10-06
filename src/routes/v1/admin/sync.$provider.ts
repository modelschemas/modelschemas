import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

import { getDb } from '#/db/index.ts'
import { isAdminRequest, jsonError } from '#/server/admin.ts'
import { errorMessage } from '#/server/errors.ts'
import { readDocsFailing } from '#/server/ingest/docs-failing.ts'
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
          const db = getDb(env)
          const outcome = await syncProvider(
            { db, kv: env.SCHEMA_CACHE, secrets: env },
            provider,
          )
          // The models poll's record of a docs source that keeps failing;
          // null when the provider's docs load.
          const docsFailing = await readDocsFailing(db, provider.id)
          return Response.json({ outcome, docsFailing })
        } catch (error) {
          return jsonError(502, 'sync_failed', errorMessage(error))
        }
      },
    },
  },
})
