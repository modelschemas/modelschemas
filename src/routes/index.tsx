import { createFileRoute } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'

import type { ServiceStatus } from '#/server/status.ts'

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
      listChanges(db, { limit: 15 }),
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
  component: Dashboard,
})

const STATUS_STYLES: Record<string, string> = {
  active: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  degraded: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  disabled: 'bg-zinc-500/15 text-zinc-500',
}

const CHANGE_STYLES: Record<string, string> = {
  'model.added': 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  'model.removed': 'bg-red-500/15 text-red-600 dark:text-red-400',
  'model.updated': 'bg-sky-500/15 text-sky-600 dark:text-sky-400',
  'schema.added': 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  'schema.updated': 'bg-violet-500/15 text-violet-600 dark:text-violet-400',
  'endpoint.added': 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  'endpoint.removed': 'bg-red-500/15 text-red-600 dark:text-red-400',
}

function Badge({ label, styles }: { label: string; styles?: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${styles ?? 'bg-zinc-500/15 text-zinc-500'}`}
    >
      {label}
    </span>
  )
}

export function timeAgo(epochSeconds: number | null): string {
  if (!epochSeconds) return 'never'
  const delta = Math.max(0, Math.floor(Date.now() / 1000) - epochSeconds)
  if (delta < 90) return `${String(delta)}s ago`
  if (delta < 5400) return `${String(Math.round(delta / 60))}m ago`
  if (delta < 129_600) return `${String(Math.round(delta / 3600))}h ago`
  return `${String(Math.round(delta / 86_400))}d ago`
}

function Dashboard() {
  const { status, changes } = Route.useLoaderData()
  const totals = status.providers.reduce(
    (acc, p) => ({
      models: acc.models + p.counts.models,
      endpoints: acc.endpoints + p.counts.endpoints,
      schemas: acc.schemas + p.counts.schemas,
    }),
    { models: 0, endpoints: 0, schemas: 0 },
  )

  return (
    <div className="mx-auto max-w-5xl space-y-8 p-8">
      <header className="space-y-2">
        <h1 className="text-3xl font-bold tracking-tight">modelschemas</h1>
        <p className="text-zinc-500">
          Live AI model schemas: per-endpoint request/response JSON Schemas and
          model metadata, auto-refreshed.
        </p>
        <nav className="flex flex-wrap gap-4 text-sm">
          <a className="underline underline-offset-4" href="/v1">
            API index
          </a>
          <a className="underline underline-offset-4" href="/openapi.json">
            openapi.json
          </a>
          <a className="underline underline-offset-4" href="/llms.txt">
            llms.txt
          </a>
          <a
            className="underline underline-offset-4"
            href="/.well-known/agent-configuration"
          >
            agent discovery
          </a>
          <a className="underline underline-offset-4" href="/docs">
            docs
          </a>
        </nav>
      </header>

      <section className="grid grid-cols-3 gap-4">
        {(
          [
            ['Models', totals.models],
            ['Endpoints', totals.endpoints],
            ['Schemas', totals.schemas],
          ] as const
        ).map(([label, n]) => (
          <div
            key={label}
            className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-800"
          >
            <div className="text-2xl font-semibold tabular-nums">{n}</div>
            <div className="text-sm text-zinc-500">{label}</div>
          </div>
        ))}
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Providers</h2>
        <div className="overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-left text-zinc-500 dark:bg-zinc-900">
              <tr>
                <th className="px-4 py-2 font-medium">Provider</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Models</th>
                <th className="px-4 py-2 font-medium">Schemas</th>
                <th className="px-4 py-2 font-medium">Polled</th>
                <th className="px-4 py-2 font-medium">Synced</th>
              </tr>
            </thead>
            <tbody>
              {status.providers.map((p) => (
                <tr
                  key={p.id}
                  className="border-t border-zinc-200 dark:border-zinc-800"
                >
                  <td className="px-4 py-2 font-medium">{p.displayName}</td>
                  <td className="px-4 py-2">
                    <Badge label={p.status} styles={STATUS_STYLES[p.status]} />
                  </td>
                  <td className="px-4 py-2 tabular-nums">{p.counts.models}</td>
                  <td className="px-4 py-2 tabular-nums">{p.counts.schemas}</td>
                  <td className="px-4 py-2 text-zinc-500">
                    {timeAgo(p.lastPolledAt)}
                  </td>
                  <td className="px-4 py-2 text-zinc-500">
                    {timeAgo(p.lastSyncedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Latest changes</h2>
        {changes.length === 0 ? (
          <p className="text-sm text-zinc-500">
            No changes yet — trigger a sync via POST /v1/admin/sync/
            {'{provider}'}.
          </p>
        ) : (
          <ul className="space-y-2">
            {changes.map((change) => (
              <li
                key={change.id}
                className="flex items-baseline gap-3 rounded-lg border border-zinc-200 px-4 py-2 text-sm dark:border-zinc-800"
              >
                <Badge
                  label={change.type}
                  styles={CHANGE_STYLES[change.type]}
                />
                <span className="flex-1">{change.summary}</span>
                <span className="shrink-0 text-xs text-zinc-500">
                  {change.providerId} · {timeAgo(change.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
