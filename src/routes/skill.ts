import { createFileRoute } from '@tanstack/react-router'

import { skillMd } from '#/server/skill.ts'

export const Route = createFileRoute('/skill')({
  server: {
    handlers: {
      GET: () =>
        new Response(skillMd, {
          headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
        }),
    },
  },
})
