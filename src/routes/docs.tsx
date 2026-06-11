import { createFileRoute } from '@tanstack/react-router'
import { Streamdown } from 'streamdown'

import { llmsTxt } from '#/server/llms-txt.ts'

export const Route = createFileRoute('/docs')({
  component: Docs,
})

const LINKS: Array<[label: string, href: string]> = [
  ['Dashboard', '/'],
  ['API index', '/v1'],
  ['openapi.json', '/openapi.json'],
  ['llms.txt (this content, raw)', '/llms.txt'],
  ['Agent discovery', '/.well-known/agent-configuration'],
  ['Service status', '/v1/status'],
  ['Model catalog', '/v1/models'],
  ['Changes feed', '/v1/changes'],
  ['Agent skill (SKILL.md)', '/skill'],
]

function Docs() {
  return (
    <div className="mx-auto max-w-3xl space-y-8 p-8">
      <nav className="flex flex-wrap gap-4 text-sm">
        {LINKS.map(([label, href]) => (
          <a key={href} className="underline underline-offset-4" href={href}>
            {label}
          </a>
        ))}
      </nav>
      {/* Rendered from the exact llms.txt source so the human docs can never
          drift from what agents read. */}
      <article className="prose prose-zinc dark:prose-invert max-w-none">
        <Streamdown>{llmsTxt}</Streamdown>
      </article>
    </div>
  )
}
