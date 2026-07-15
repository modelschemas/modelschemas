import { useEffect } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'

import { registerWebMcp } from '#/lib/webmcp.ts'
import { timeAgo } from '#/lib/time.ts'
import { EXAMPLES } from '#/lib/examples.ts'

import {
  CHANGE_STYLES,
  CodePanel,
  SectionHead,
  SiteFooter,
  SiteNav,
  StatusDot,
} from '#/components/site.tsx'
import type { ServiceStatus } from '#/server/status.ts'

export { timeAgo } from '#/lib/time.ts'

interface DashboardChange {
  id: string
  type: string
  providerId: string
  summary: string
  createdAt: number
}

interface DashboardData {
  status: ServiceStatus
  changes: Array<DashboardChange>
}

const getDashboardData = createServerFn({ method: 'GET' }).handler(
  async (): Promise<DashboardData> => {
    const { env } = await import('cloudflare:workers')
    const { getDb } = await import('#/db/index.ts')
    const { getServiceStatus } = await import('#/server/status.ts')
    const { listChanges } = await import('#/server/changes-api.ts')

    const db = getDb(env)
    const [status, changesOutcome] = await Promise.all([
      getServiceStatus(db),
      listChanges(db, { limit: 8 }),
    ])
    return {
      status,
      changes: changesOutcome.ok
        ? changesOutcome.result.changes.map((c) => ({
            id: c.id,
            type: c.type,
            providerId: c.providerId,
            summary: c.summary,
            createdAt: c.createdAt,
          }))
        : [],
    }
  },
)

export const Route = createFileRoute('/')({
  loader: () => getDashboardData(),
  component: Landing,
})

const fmt = new Intl.NumberFormat('en-US')

function Landing() {
  const { status, changes } = Route.useLoaderData()
  // WebMCP (task 10.6): in-page tools for browsers that ship
  // navigator.modelContext; silently absent everywhere else.
  useEffect(() => {
    registerWebMcp()
  }, [])
  const totals = status.providers.reduce(
    (acc, p) => ({
      models: acc.models + p.counts.models,
      endpoints: acc.endpoints + p.counts.endpoints,
      schemas: acc.schemas + p.counts.schemas,
    }),
    { models: 0, endpoints: 0, schemas: 0 },
  )
  const lastPolledAt = Math.max(
    0,
    ...status.providers.map((p) => p.lastPolledAt ?? 0),
  )
  const lastSyncedAt = Math.max(
    0,
    ...status.providers.map((p) => p.lastSyncedAt ?? 0),
  )

  return (
    <div className="min-h-screen text-ink">
      <SiteNav />

      <main className="mx-auto max-w-[1080px] px-6 pb-16">
        <header className="pt-13">
          <h1 className="m-0 mb-3 max-w-[30em] font-mono text-[clamp(22px,3.4vw,30px)] leading-[1.25] font-semibold tracking-[-0.01em] text-balance">
            Live request &amp; response schemas for every AI model API
            <span className="text-tok-blue">▌</span>
          </h1>
          <p className="m-0 mb-6 max-w-[40em] text-[14.5px] text-ink-soft">
            Which models exist right now, and what their payloads look like.
            JSON Schemas for {status.providers.length} providers, refreshed
            automatically, served as plain JSON over HTTP — no key needed for
            reads.
          </p>

          <CodePanel
            title="try it"
            copyText="curl https://modelschemas.com/v1/models?q=claude"
          >
            <code>
              <span className="prompt">$</span> curl{' '}
              <span className="cj-str">
                https://modelschemas.com/v1/models?q=claude
              </span>
              {'\n'}
              <span className="cj-dim">{'{'} </span>
              <span className="cj-key">"id"</span>
              <span className="cj-dim">: </span>
              <span className="cj-str">"anthropic-claude-sonnet-5"</span>
              <span className="cj-dim">, </span>
              <span className="cj-key">"rawId"</span>
              <span className="cj-dim">: </span>
              <span className="cj-str">"claude-sonnet-5"</span>
              <span className="cj-dim">, </span>
              <span className="cj-key">"lastSeenAt"</span>
              <span className="cj-dim">: </span>
              <span className="cj-num">{lastPolledAt || 1783408549}</span>
              <span className="cj-dim">, … {'}'}</span>
            </code>
          </CodePanel>

          <div className="mt-5 flex flex-wrap gap-2.5 font-mono text-[12.5px]">
            <a
              href="/models"
              className="rounded-[4px] border border-ink bg-ink px-3.5 py-2 text-paper transition-opacity hover:opacity-85"
            >
              GET /v1/models
            </a>
            <a
              href="/docs"
              className="rounded-[4px] border border-rule-strong px-3.5 py-2 transition-colors hover:border-ink"
            >
              docs
            </a>
            <a
              href="/mcp"
              className="rounded-[4px] border border-rule-strong px-3.5 py-2 transition-colors hover:border-ink"
            >
              /mcp
            </a>
            <a
              href="/llms.txt"
              className="rounded-[4px] border border-rule-strong px-3.5 py-2 transition-colors hover:border-ink"
            >
              /llms.txt
            </a>
          </div>

          <div className="hairline mt-11 flex flex-wrap gap-x-5 gap-y-2 border-y py-3 font-mono text-xs text-ink-soft">
            <span className="inline-flex items-center gap-2">
              <span className="pulse-dot bg-tok-green" />
              <span className="text-tok-green">live</span>
            </span>
            <span>
              <b className="font-semibold text-ink tabular-nums">
                {status.providers.length}
              </b>{' '}
              providers
            </span>
            <span>
              <b className="font-semibold text-ink tabular-nums">
                {fmt.format(totals.models)}
              </b>{' '}
              models
            </span>
            <span>
              <b className="font-semibold text-ink tabular-nums">
                {fmt.format(totals.endpoints)}
              </b>{' '}
              endpoints
            </span>
            <span>
              <b className="font-semibold text-ink tabular-nums">
                {fmt.format(totals.schemas)}
              </b>{' '}
              schema versions
            </span>
            <span>
              polled{' '}
              <b className="font-semibold text-ink">{timeAgo(lastPolledAt)}</b>{' '}
              · specs synced{' '}
              <b className="font-semibold text-ink">{timeAgo(lastSyncedAt)}</b>
            </span>
          </div>
        </header>

        <section>
          <SectionHead
            title="Providers"
            aside={
              <a className="press-link" href="/v1/providers">
                GET /v1/providers →
              </a>
            }
          />
          <div className="figure overflow-x-auto">
            <table className="dtable">
              <thead>
                <tr>
                  <th>provider</th>
                  <th>status</th>
                  <th className="num">models</th>
                  <th className="num">endpoints</th>
                  <th className="num">schemas</th>
                  <th className="num max-sm:hidden">polled</th>
                  <th className="num max-sm:hidden">synced</th>
                </tr>
              </thead>
              <tbody>
                {status.providers.map((p) => (
                  <tr key={p.id}>
                    <td className="font-medium">
                      <a
                        className="text-ink hover:text-tok-blue"
                        href={`/models?provider=${p.id}`}
                      >
                        {p.displayName}
                      </a>
                    </td>
                    <td>
                      <StatusDot status={p.status} />
                    </td>
                    <td className="num">{fmt.format(p.counts.models)}</td>
                    <td className="num">{fmt.format(p.counts.endpoints)}</td>
                    <td className="num">{fmt.format(p.counts.schemas)}</td>
                    <td className="num text-ink-faint max-sm:hidden">
                      {timeAgo(p.lastPolledAt)}
                    </td>
                    <td className="num text-ink-faint max-sm:hidden">
                      {timeAgo(p.lastSyncedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section>
          <SectionHead
            title="Recent changes"
            aside={
              <a className="press-link" href="/changes">
                GET /v1/changes →
              </a>
            }
          />
          {changes.length === 0 ? (
            <p className="font-mono text-sm text-ink-faint">
              no changes yet — the next cron poll will populate this feed.
            </p>
          ) : (
            <>
              <div className="figure overflow-x-auto">
                <table className="dtable">
                  <tbody>
                    {changes.map((change) => (
                      <tr key={change.id}>
                        <td className="font-mono text-xs whitespace-nowrap text-ink-faint">
                          {timeAgo(change.createdAt)}
                        </td>
                        <td
                          className={`font-mono text-xs whitespace-nowrap ${CHANGE_STYLES[change.type] ?? 'text-ink-soft'}`}
                        >
                          {change.type}
                        </td>
                        <td className="max-w-[38em] truncate">
                          {change.summary}
                        </td>
                        <td className="font-mono text-xs text-ink-faint max-sm:hidden">
                          {change.providerId}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-2.5 font-mono text-xs text-ink-faint">
                Subscribe with a webhook to get these pushed —{' '}
                <a className="press-link" href="/docs">
                  POST /v1/subscriptions
                </a>
              </p>
            </>
          )}
        </section>

        <section>
          <SectionHead
            title="Examples"
            aside={
              <a className="press-link" href="/examples">
                /examples →
              </a>
            }
          />
          <div className="figure overflow-x-auto">
            <table className="dtable">
              <tbody>
                {EXAMPLES.map((example) => (
                  <tr key={example.slug}>
                    <td className="font-mono text-xs whitespace-nowrap">
                      <a
                        className="press-link"
                        href={`/examples/${example.slug}/`}
                      >
                        {example.slug}
                      </a>
                    </td>
                    <td className="max-w-[38em]">{example.blurb}</td>
                    <td className="font-mono text-xs whitespace-nowrap text-ink-faint max-sm:hidden">
                      {example.package}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  )
}
