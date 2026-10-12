import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

import { getDb } from '#/db/index.ts'
import { captureServerEvent } from '#/lib/posthog-server.ts'
import { jsonError } from '#/server/admin.ts'
import { getAuth } from '#/server/auth.ts'
import { requireAgent } from '#/server/require-agent.ts'
import { deleteSubscription } from '#/server/subscriptions-api.ts'

export const Route = createFileRoute('/v1/subscriptions/$id')({
  server: {
    handlers: {
      DELETE: async ({ request, params }) => {
        const auth = await requireAgent(getAuth(), request, {
          capability: 'manage_subscriptions',
        })
        if (!auth.ok) return auth.response
        const outcome = await deleteSubscription(
          getDb(env),
          auth.principal,
          params.id,
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
          event: 'subscription_deleted',
          properties: { principal_kind: auth.principal.kind },
        })
        return Response.json(outcome.result)
      },
    },
  },
})
