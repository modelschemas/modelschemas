import { createFileRoute } from '@tanstack/react-router'
import { Streamdown } from 'streamdown'

import { SiteFooter, SiteNav } from '#/components/site.tsx'
import { llmsTxt } from '#/server/llms-txt.ts'

export const Route = createFileRoute('/docs')({
  component: Docs,
})

const LINKS: Array<[label: string, href: string]> = [
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
    <div className="min-h-screen text-ink">
      <SiteNav active="docs" />
      <div className="mx-auto max-w-3xl space-y-10 px-5 py-14">
        <header className="space-y-4">
          <h1 className="font-mono text-2xl font-semibold tracking-tight">
            Documentation<span className="text-tok-blue">▌</span>
          </h1>
          <p className="font-mono text-xs text-ink-faint">
            rendered from the exact /llms.txt agents fetch — zero drift by
            construction.
          </p>
          <nav className="hairline flex flex-wrap gap-x-5 gap-y-1.5 border-y py-2.5 font-mono text-xs">
            {LINKS.map(([label, href]) => (
              <a key={href} className="press-link" href={href}>
                {label}
              </a>
            ))}
          </nav>
        </header>

        {/* Rendered from the exact llms.txt source so the human docs can never
            drift from what agents read. */}
        <article className="prose max-w-none prose-headings:font-mono prose-headings:font-semibold prose-headings:text-ink prose-p:text-ink-soft prose-li:text-ink-soft prose-strong:text-ink prose-code:text-tok-blue prose-a:text-tok-blue prose-li:marker:text-ink-faint">
          <Streamdown>{llmsTxt}</Streamdown>
        </article>
      </div>
      <SiteFooter />
    </div>
  )
}
