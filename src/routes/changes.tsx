import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'

import {
  CHANGE_STYLES,
  JsonPane,
  MetaStrip,
  ReqLine,
  SiteFooter,
  SiteNav,
  ViewToggle,
} from '#/components/site.tsx'
import type { ResourceView } from '#/components/site.tsx'
import { timeAgo } from '#/lib/time.ts'

interface ChangesSearch {
  cursor?: string
  provider?: string
}

interface ChangeRow {
  id: string
  type: string
  providerId: string
  subjectId: string
  summary: string
  createdAt: number
}

interface ChangesData {
  count: number
  changes: Array<ChangeRow>
  nextCursor: string | null
}

const getChanges = createServerFn({ method: 'GET' })
  .inputValidator((query: ChangesSearch) => query)
  .handler(async ({ data }): Promise<ChangesData> => {
    const { env } = await import('cloudflare:workers')
    const { getDb } = await import('#/db/index.ts')
    const { listChanges } = await import('#/server/changes-api.ts')
    const outcome = await listChanges(getDb(env), { ...data, limit: 50 })
    if (!outcome.ok) return { count: 0, changes: [], nextCursor: null }
    return {
      count: outcome.result.count,
      nextCursor: outcome.result.nextCursor,
      changes: outcome.result.changes.map((c) => ({
        id: c.id,
        type: c.type,
        providerId: c.providerId,
        subjectId: c.subjectId,
        summary: c.summary,
        createdAt: c.createdAt,
      })),
    }
  })

export const Route = createFileRoute('/changes')({
  validateSearch: (search: Record<string, unknown>): ChangesSearch => ({
    cursor:
      typeof search.cursor === 'string' && search.cursor !== ''
        ? search.cursor
        : undefined,
    provider:
      typeof search.provider === 'string' && search.provider !== ''
        ? search.provider
        : undefined,
  }),
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => getChanges({ data: deps }),
  component: Changes,
})

function Changes() {
  const data = Route.useLoaderData()
  const search = Route.useSearch()
  const [view, setView] = useState<ResourceView>('readable')

  const params = new URLSearchParams()
  if (search.provider) params.set('provider', search.provider)
  if (search.cursor) params.set('cursor', search.cursor)
  const qs = params.toString() === '' ? '' : `?${params.toString()}`
  const apiPath = `/v1/changes${qs}`
  const jsonBody = JSON.stringify(
    { count: data.count, changes: data.changes, nextCursor: data.nextCursor },
    null,
    2,
  )

  const olderParams = new URLSearchParams()
  if (search.provider) olderParams.set('provider', search.provider)
  if (data.nextCursor) olderParams.set('cursor', data.nextCursor)

  return (
    <div className="min-h-screen text-ink">
      <SiteNav active="changes" />
      <main className="mx-auto max-w-[1080px] px-6 pb-16">
        <ReqLine
          path={
            <>
              /v1/changes
              {qs === '' ? null : <span className="text-ink-faint">{qs}</span>}
            </>
          }
          copyUrl={`https://modelschemas.com${apiPath}`}
          right={<ViewToggle view={view} onChange={setView} />}
        />
        <MetaStrip
          items={[
            ['count', String(data.count)],
            ['order', 'newest first'],
            ['page size', '50'],
          ]}
        />

        {view === 'json' ? (
          <JsonPane
            title="application/json · 200 OK"
            json={jsonBody}
            note={
              <>
                identical body to{' '}
                <code>curl https://modelschemas.com{apiPath}</code>
              </>
            }
          />
        ) : (
          <>
            <div className="figure overflow-x-auto">
              <table className="dtable">
                <thead>
                  <tr>
                    <th>when</th>
                    <th>type</th>
                    <th>summary</th>
                    <th className="max-sm:hidden">provider</th>
                  </tr>
                </thead>
                <tbody>
                  {data.changes.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="text-ink-faint">
                        no changes yet — the next cron poll will populate this
                        feed.
                      </td>
                    </tr>
                  ) : (
                    data.changes.map((change) => (
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
                          <a
                            className="press-link"
                            href={`/changes?provider=${change.providerId}`}
                          >
                            {change.providerId}
                          </a>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <div className="mt-2.5 flex flex-wrap gap-4 font-mono text-xs">
              {data.nextCursor === null ? null : (
                <a
                  className="press-link"
                  href={`/changes?${olderParams.toString()}`}
                >
                  older →
                </a>
              )}
              <span className="ml-auto text-ink-faint">
                webhook push:{' '}
                <a className="press-link" href="/docs">
                  POST /v1/subscriptions
                </a>
              </span>
            </div>
          </>
        )}
      </main>
      <SiteFooter />
    </div>
  )
}
