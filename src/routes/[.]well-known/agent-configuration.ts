import { createFileRoute } from '@tanstack/react-router'

import { getAuth } from '#/server/auth.ts'

export const Route = createFileRoute('/.well-known/agent-configuration')({
  server: {
    handlers: {
      GET: async () =>
        Response.json(await getAuth().api.getAgentConfiguration()),
    },
  },
})
