import { createFileRoute } from '@tanstack/react-router'

import { env } from 'cloudflare:workers'

import { getDb } from '#/db/index.ts'
import { jsonError } from '#/server/admin.ts'
import { parseRegisterKeyBody, registerKeyAgent } from '#/server/agents-api.ts'
import { getAuth } from '#/server/auth.ts'

export const Route = createFileRoute('/v1/agents/register-key')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let raw: unknown
        try {
          raw = await request.json()
        } catch {
          return jsonError(400, 'invalid_json', 'Request body must be JSON.')
        }
        const body = parseRegisterKeyBody(raw)
        if (!body) {
          return jsonError(
            400,
            'invalid_request',
            'Body must be { name: string, email?: string }.',
          )
        }
        const outcome = await registerKeyAgent(getAuth(), getDb(env), body)
        if (!outcome.ok) {
          return jsonError(outcome.status, outcome.code, outcome.message)
        }
        return Response.json(outcome.result, { status: 201 })
      },
    },
  },
})
