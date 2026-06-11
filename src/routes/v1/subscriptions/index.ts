import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

import { getDb } from '#/db/index.ts'
import { jsonError } from '#/server/admin.ts'
import { getAuth } from '#/server/auth.ts'
import { requireAgent } from '#/server/require-agent.ts'
import {
  createSubscription,
  listSubscriptions,
  parseCreateSubscriptionBody,
} from '#/server/subscriptions-api.ts'

export const Route = createFileRoute('/v1/subscriptions/')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const auth = await requireAgent(getAuth(), request, {
          capability: 'manage_subscriptions',
        })
        if (!auth.ok) return auth.response
        return Response.json(
          await listSubscriptions(getDb(env), auth.principal),
        )
      },
      POST: async ({ request }) => {
        const auth = await requireAgent(getAuth(), request, {
          capability: 'manage_subscriptions',
        })
        if (!auth.ok) return auth.response
        let raw: unknown
        try {
          raw = await request.json()
        } catch {
          return jsonError(400, 'invalid_json', 'Request body must be JSON.')
        }
        const body = parseCreateSubscriptionBody(raw)
        if (!body) {
          return jsonError(
            400,
            'invalid_request',
            'Body must be { url: public https URL, events: ChangeType[], provider?: string }.',
          )
        }
        const outcome = await createSubscription(
          getDb(env),
          auth.principal,
          body,
        )
        if (!outcome.ok) {
          return jsonError(outcome.status, outcome.code, outcome.message)
        }
        return Response.json(outcome.result, { status: 201 })
      },
    },
  },
})
