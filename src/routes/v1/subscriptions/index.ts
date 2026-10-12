import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

import { getDb } from '#/db/index.ts'
import { captureServerEvent } from '#/lib/posthog-server.ts'
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
        await captureServerEvent({
          request,
          distinctId:
            auth.principal.userId ??
            (auth.principal.kind === 'agent'
              ? auth.principal.agentId
              : auth.principal.keyId),
          event: 'subscription_created',
          properties: {
            event_count: body.events.length,
            principal_kind: auth.principal.kind,
            provider_filtered: body.provider !== undefined,
          },
        })
        return Response.json(outcome.result, { status: 201 })
      },
    },
  },
})
