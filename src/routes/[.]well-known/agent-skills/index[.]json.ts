import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

import { agentSkillsIndex } from '#/server/discovery.ts'

export const Route = createFileRoute('/.well-known/agent-skills/index.json')({
  server: {
    handlers: {
      GET: async () =>
        Response.json(await agentSkillsIndex(env.BETTER_AUTH_URL)),
    },
  },
})
