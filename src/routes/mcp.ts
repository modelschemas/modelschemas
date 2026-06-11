import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

import { getDb } from '#/db/index.ts'
import { handleMcpRequest } from '#/server/mcp.ts'

export const Route = createFileRoute('/mcp')({
  server: {
    handlers: {
      GET: ({ request }) => handleMcpRequest(getDb(env), request),
      POST: ({ request }) => handleMcpRequest(getDb(env), request),
    },
  },
})
