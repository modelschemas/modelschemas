import { createFileRoute } from '@tanstack/react-router'

import { getAuth } from '#/server/auth.ts'
import { requireAgent } from '#/server/require-agent.ts'

export const Route = createFileRoute('/v1/agents/me')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const result = await requireAgent(getAuth(), request)
        if (!result.ok) return result.response
        return Response.json({ agent: result.principal })
      },
    },
  },
})
