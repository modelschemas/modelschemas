import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

import { getDb } from '#/db/index.ts'
import { isAdminRequest, jsonError } from '#/server/admin.ts'
import { exportCatalogStream } from '#/server/export.ts'

export const Route = createFileRoute('/v1/admin/export')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAdminRequest(request, env.ADMIN_KEY)) {
          return jsonError(
            401,
            'unauthorized',
            'Provide the admin key via X-Admin-Key or Authorization: Bearer.',
          )
        }
        return new Response(exportCatalogStream(getDb(env)), {
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          },
        })
      },
    },
  },
})
