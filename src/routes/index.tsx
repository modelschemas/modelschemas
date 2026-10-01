import { useEffect } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'

import { registerWebMcp } from '#/lib/webmcp.ts'
import { timeAgo } from '#/lib/time.ts'
import { EXAMPLES } from '#/lib/examples.ts'

import {
  CHANGE_STYLES,
  ChangeSummary,
  CodePanel,
  SectionHead,
  SiteFooter,
  SiteNav,
  StatusDot,
} from '#/components/site.tsx'
import type { ChangeType } from '#/db/schema.ts'
import type { ServiceStatus } from '#/server/status.ts'

export { timeAgo } from '#/lib/time.ts'

interface DashboardChange {
  id: string
  type: string
  providerId: string
  subjectId: string
  summary: string
  createdAt: number
}

interface DashboardData {
  status: ServiceStatus
  changes: Array<DashboardChange>
  drift: Partial<Record<ChangeType, number>>
}

/** Window for the landing page's "how much moved" tally. */
const DRIFT_WINDOW_DAYS = 30

const getDashboardData = createServerFn({ method: 'GET' }).handler(
  async (): Promise<DashboardData> => {
    const { env } = await import('cloudflare:workers')
    const { getDb } = await import('#/db/index.ts')
    const { getServiceStatus } = await import('#/server/status.ts')
    const { countChangesByType, listChanges } =
      await import('#/server/changes-api.ts')

    const db = getDb(env)
    const since = Math.floor(Date.now() / 1000) - DRIFT_WINDOW_DAYS * 86_400
    const [status, changesOutcome, drift] = await Promise.all([
      getServiceStatus(db),
      listChanges(db, { limit: 8 }),
      countChangesByType(db, since),
    ])
    return {
      status,
      drift,
      changes: changesOutcome.ok
        ? changesOutcome.result.changes.map((c) => ({
            id: c.id,
            type: c.type,
            providerId: c.providerId,
            subjectId: c.subjectId,
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

const BEFORE_CODE = `// written once, from last quarter's docs
type ChatRequest = {
  model: 'gpt-4o' | 'claude-3-5-sonnet'
  max_tokens: number
  temperature?: number
}

// a model is retired, a field is renamed,
// a new one becomes required…
// you find out from a 400 in production.`

const AFTER_CODE = `import {
  createModelschemasClient,
  validatePayload,
} from '@modelschemas/client'

const client = createModelschemasClient({
  baseUrl: 'https://modelschemas.com',
})

// checked against today's published schema
const { data } = await validatePayload({
  client,
  body: {
    provider: 'anthropic',
    endpointId: 'v1/messages',
    payload,
  },
})
if (!data?.valid) console.error(data?.errors)`

interface Audience {
  who: string
  pitch: string
  links: Array<[label: string, href: string]>
}

const AUDIENCES: Array<Audience> = [
  {
    who: 'AI agents',
    pitch:
      'Training data is months old. Point an agent at the live catalog and it looks up current model ids and exact payload shapes instead of guessing.',
    links: [
      ['/llms.txt', '/llms.txt'],
      ['/mcp', '/mcp'],
      ['/skill', '/skill'],
    ],
  },
  {
    who: 'App developers',
    pitch:
      'Validate a payload before you spend tokens, generate TypeScript from the real schema at dev time, and see the upstream diff when it moves.',
    links: [
      ['@modelschemas/client', '/docs'],
      ['@modelschemas/vite', '/docs'],
      ['examples', '/examples'],
    ],
  },
  {
    who: 'Platform teams',
    pitch:
      'Get a webhook when a provider ships, retires or reshapes something. Pin schema versions by content hash and estimate a request’s cost up front.',
    links: [
      ['change feed', '/changes'],
      ['POST /v1/subscriptions', '/docs'],
      ['POST /v1/estimate', '/docs'],
    ],
  },
]

function Landing() {
  const { status, changes, drift } = Route.useLoaderData()
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
  const tally = (...types: Array<ChangeType>) =>
    types.reduce((sum, t) => sum + (drift[t] ?? 0), 0)
  const problems: Array<{
    count: number
    unit: string
    title: string
    body: string
    href: string
    tone: string
  }> = [
    {
      count: tally('model.added', 'model.removed'),
      unit: 'models added or retired',
      title: 'Model ids churn',
      body: 'New models ship without notice and old ones disappear. A hard-coded model list is stale the week you write it.',
      href: '/changes',
      tone: 'text-tok-green',
    },
    {
      count: tally(
        'schema.added',
        'schema.updated',
        'endpoint.added',
        'endpoint.removed',
      ),
      unit: 'schema & endpoint changes',
      title: 'Payloads drift',
      body: 'Fields get added, renamed and constrained. SDK types and hand-written interfaces lag behind the real API.',
      href: '/schemas',
      tone: 'text-tok-amber',
    },
    {
      count: tally('model.updated'),
      unit: 'model metadata updates',
      title: 'Prices & limits move',
      body: 'Context windows, reasoning modes and rate cards change underneath you, and every provider publishes them differently.',
      href: '/models',
      tone: 'text-tok-blue',
    },
  ]

  return (
    <div className="min-h-screen text-ink">
      <SiteNav />

      <main className="mx-auto max-w-[1080px] px-6 pb-16">
        <header className="pt-13">
          <p className="m-0 mb-3 font-mono text-xs text-ink-faint">
            live JSON Schemas for every AI model API
          </p>
          <h1 className="m-0 mb-4 max-w-[24em] font-mono text-[clamp(24px,4vw,36px)] leading-[1.2] font-semibold tracking-[-0.015em] text-balance">
            AI provider APIs change every week. Find out before your users do
            <span className="text-tok-blue">▌</span>
          </h1>
          <p className="m-0 mb-6 max-w-[42em] text-[15px] leading-relaxed text-ink-soft">
            modelschemas watches {status.providers.length} providers and keeps a
            live, versioned record of which models exist, what their request and
            response payloads look like, and what they cost. Read it as JSON
            over HTTP, through MCP, or have changes pushed to a webhook. No key
            needed for reads.
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
              browse models
            </a>
            <a
              href="/schemas"
              className="rounded-[4px] border border-rule-strong px-3.5 py-2 transition-colors hover:border-ink"
            >
              browse schemas
            </a>
            <a
              href="/changes"
              className="rounded-[4px] border border-rule-strong px-3.5 py-2 transition-colors hover:border-ink"
            >
              what changed
            </a>
            <a
              href="/docs"
              className="rounded-[4px] border border-rule-strong px-3.5 py-2 transition-colors hover:border-ink"
            >
              docs
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
            title="Why it matters"
            aside={`counted from the change feed · last ${String(DRIFT_WINDOW_DAYS)} days`}
          />
          <div className="grid gap-3 sm:grid-cols-3">
            {problems.map((p) => (
              <a
                key={p.title}
                href={p.href}
                className="figure block p-4 transition-colors hover:border-rule-strong"
              >
                <div
                  className={`font-mono text-[28px] leading-none font-semibold tabular-nums ${p.tone}`}
                >
                  {fmt.format(p.count)}
                </div>
                <div className="mt-1 font-mono text-[11.5px] text-ink-faint">
                  {p.unit}
                </div>
                <h3 className="mt-4 mb-1.5 font-mono text-sm font-semibold text-ink">
                  {p.title}
                </h3>
                <p className="m-0 text-[13.5px] leading-relaxed text-ink-soft">
                  {p.body}
                </p>
              </a>
            ))}
          </div>
        </section>

        <section>
          <SectionHead
            title="Before & after"
            aside="the same request, two ways"
          />
          <div className="grid gap-3 md:grid-cols-2">
            <CodePanel title="hand-written · drifts silently">
              <code>{BEFORE_CODE}</code>
            </CodePanel>
            <CodePanel title="live schema · fails loudly" copyText={AFTER_CODE}>
              <code>{AFTER_CODE}</code>
            </CodePanel>
          </div>
          <p className="mt-2.5 font-mono text-xs text-ink-faint">
            prefer types? <code>@modelschemas/vite</code> pulls the schema and
            generated TypeScript into your repo and reports drift on every dev
            run.
          </p>
        </section>

        <section>
          <SectionHead
            title="Drift, as it happened"
            aside={
              <a className="press-link" href="/changes">
                all changes →
              </a>
            }
          />
          {changes.length === 0 ? (
            <p className="font-mono text-sm text-ink-faint">
              no changes yet. The next cron poll will populate this feed.
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
                          <ChangeSummary change={change} />
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
                Each row would have been a surprise in someone’s code. Get them
                pushed with a webhook:{' '}
                <a className="press-link" href="/docs">
                  POST /v1/subscriptions
                </a>
              </p>
            </>
          )}
        </section>

        <section>
          <SectionHead title="Who it’s for" />
          <div className="grid gap-3 sm:grid-cols-3">
            {AUDIENCES.map((a) => (
              <div key={a.who} className="figure p-4">
                <h3 className="m-0 mb-1.5 font-mono text-sm font-semibold text-ink">
                  {a.who}
                </h3>
                <p className="m-0 mb-3 text-[13.5px] leading-relaxed text-ink-soft">
                  {a.pitch}
                </p>
                <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11.5px]">
                  {a.links.map(([label, href]) => (
                    <a key={label} className="press-link" href={href}>
                      {label}
                    </a>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>

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
                    <td className="num">
                      {p.counts.schemas > 0 ? (
                        <a
                          className="text-ink hover:text-tok-blue"
                          href={`/schemas?provider=${p.id}`}
                        >
                          {fmt.format(p.counts.schemas)}
                        </a>
                      ) : (
                        fmt.format(p.counts.schemas)
                      )}
                    </td>
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
          <p className="mt-2.5 font-mono text-xs text-ink-faint">
            model lists are polled every 15 minutes; API specs are re-extracted
            daily.
          </p>
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
