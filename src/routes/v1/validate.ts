import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

import { getDb } from '#/db/index.ts'
import { captureServerEvent } from '#/lib/posthog-server.ts'
import { jsonError } from '#/server/admin.ts'
import { parseValidateBody, validatePayload } from '#/server/validate.ts'

export const Route = createFileRoute('/v1/validate')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let raw: unknown
        try {
          raw = await request.json()
        } catch {
          return jsonError(400, 'invalid_json', 'Request body must be JSON.')
        }
        const body = parseValidateBody(raw)
        if (!body) {
          return jsonError(
            400,
            'invalid_request',
            'Body must be { provider: string, endpointId: string, kind?: "input"|"output", payload: any }.',
          )
        }
        const outcome = await validatePayload(getDb(env), body)
        if (!outcome.ok) {
          return jsonError(outcome.status, outcome.code, outcome.message)
        }
        await captureServerEvent({
          request,
          event: 'payload_validated',
          properties: {
            endpoint_id: outcome.result.endpointId,
            error_count: outcome.result.errors.length,
            kind: outcome.result.kind,
            provider: outcome.result.provider,
            valid: outcome.result.valid,
          },
        })
        return Response.json(outcome.result)
      },
    },
  },
})
