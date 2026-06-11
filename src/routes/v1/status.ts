import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

import { getDb } from '#/db/index.ts'
import { halGet } from '#/server/hal.ts'
import { getServiceStatus } from '#/server/status.ts'
import { parseWaitSeconds, waitForStatusChange } from '#/server/wait.ts'

export const Route = createFileRoute('/v1/status')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        // ?wait=Ns long-poll (task 11.3): hold until a poll/sync lands.
        const waitSeconds = parseWaitSeconds(new URL(request.url))
        if (waitSeconds > 0) {
          await waitForStatusChange(getDb(env), waitSeconds)
        }
        return Response.json({
          ...(await getServiceStatus(getDb(env))),
          _links: {
            self: halGet('/v1/status'),
            index: halGet('/v1'),
            providers: halGet('/v1/providers'),
          },
        })
      },
    },
  },
})
