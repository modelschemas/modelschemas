import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

import { getDb } from '#/db/index.ts'
import { jsonError } from '#/server/admin.ts'
import { estimateCost, parseEstimateBody } from '#/server/estimate.ts'

export const Route = createFileRoute('/v1/estimate')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let raw: unknown
        try {
          raw = await request.json()
        } catch {
          return jsonError(400, 'invalid_json', 'Request body must be JSON.')
        }
        const body = parseEstimateBody(raw)
        if (!body) {
          return jsonError(
            400,
            'invalid_request',
            'Body must be { provider: string, model: string, request?: object, usage?: object }.',
          )
        }
        const outcome = await estimateCost(getDb(env), body)
        if (!outcome.ok) {
          return jsonError(outcome.status, outcome.code, outcome.message)
        }
        return Response.json(outcome.result)
      },
    },
  },
})
