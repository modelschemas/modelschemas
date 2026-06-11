import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

import { mcpServerCard } from '#/server/discovery.ts'

export const Route = createFileRoute('/.well-known/mcp/server-card.json')({
  server: {
    handlers: {
      GET: () => Response.json(mcpServerCard(env.BETTER_AUTH_URL)),
    },
  },
})
