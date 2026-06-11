import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

import { robotsTxt } from '#/server/seo.ts'

export const Route = createFileRoute('/robots.txt')({
  server: {
    handlers: {
      GET: () =>
        new Response(robotsTxt(env.BETTER_AUTH_URL), {
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        }),
    },
  },
})
