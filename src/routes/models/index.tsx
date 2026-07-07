import { useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'

import {
  JsonPane,
  MetaStrip,
  ReqLine,
  SiteFooter,
  SiteNav,
  ViewToggle,
} from '#/components/site.tsx'
import type { ResourceView } from '#/components/site.tsx'
import { activities } from '#/db/schema.ts'
import type { Activity } from '#/db/schema.ts'
import type { SerializableModel } from '#/lib/json.ts'
import { timeAgo, shortDate } from '#/lib/time.ts'

/** Rows shown / serialized per page-load; refine with filters beyond this. */
const MAX_ROWS = 200

interface CatalogSearch {
  provider?: string
  activity?: Activity
  q?: string
}

interface CatalogData {
  count: number
  models: Array<SerializableModel>
  providers: Array<string>
  truncated: boolean
}

const getCatalog = createServerFn({ method: 'GET' })
  .inputValidator((filters: CatalogSearch) => filters)
  .handler(async ({ data }): Promise<CatalogData> => {
    const { env } = await import('cloudflare:workers')
    const { getDb } = await import('#/db/index.ts')
    const { listModelsCatalog, knownProviderIds } =
      await import('#/server/catalog.ts')
    const db = getDb(env)
    const [result, providers] = await Promise.all([
      listModelsCatalog(db, data),
      knownProviderIds(db),
    ])
    return {
      count: result.count,
      // drizzle json columns are typed unknown; the values are plain JSON
      models: result.models.slice(
        0,
        MAX_ROWS,
      ) as unknown as Array<SerializableModel>,
      providers,
      truncated: result.count > MAX_ROWS,
    }
  })

export const Route = createFileRoute('/models/')({
  validateSearch: (search: Record<string, unknown>): CatalogSearch => ({
    provider:
      typeof search.provider === 'string' && search.provider !== ''
        ? search.provider
        : undefined,
    activity: (activities as ReadonlyArray<string>).includes(
      String(search.activity),
    )
      ? (search.activity as Activity)
      : undefined,
    q: typeof search.q === 'string' && search.q !== '' ? search.q : undefined,
  }),
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => getCatalog({ data: deps }),
  component: ModelsCatalog,
})

function queryString(search: CatalogSearch): string {
  const params = new URLSearchParams()
  if (search.provider) params.set('provider', search.provider)
  if (search.activity) params.set('activity', search.activity)
  if (search.q) params.set('q', search.q)
  const qs = params.toString()
  return qs === '' ? '' : `?${qs}`
}

/** Model rawIds can contain slashes (FAL); those detail URLs use the slug id. */
export function modelHref(model: SerializableModel): string {
  const id = model.rawId.includes('/') ? model.id : model.rawId
  return `/models/${model.provider}/${id}`
}

function ModelsCatalog() {
  const data = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const [view, setView] = useState<ResourceView>('readable')
  const [q, setQ] = useState(search.q ?? '')

  const qs = queryString(search)
  const apiPath = `/v1/models${qs}`
  const jsonBody = JSON.stringify(
    { count: data.count, models: data.models },
    null,
    2,
  )

  const setSearch = (patch: Partial<CatalogSearch>) => {
    void navigate({
      search: (prev: CatalogSearch): CatalogSearch => {
        const next = { ...prev, ...patch }
        return {
          provider: next.provider || undefined,
          activity: next.activity || undefined,
          q: next.q || undefined,
        }
      },
    })
  }

  const selectClasses =
    'hairline rounded-[3px] border bg-paper-raised px-2.5 py-1.5 font-mono text-xs text-ink outline-none transition-colors focus:border-rule-strong'

  return (
    <div className="min-h-screen text-ink">
      <SiteNav active="models" />
      <main className="mx-auto max-w-[1080px] px-6 pb-16">
        <ReqLine
          path={
            <>
              /v1/models
              {qs === '' ? null : <span className="text-ink-faint">{qs}</span>}
            </>
          }
          copyUrl={`https://modelschemas.com${apiPath}`}
          right={<ViewToggle view={view} onChange={setView} />}
        />
        <MetaStrip
          items={[
            ['count', String(data.count)],
            ['cache', 'swr'],
            ['shown', data.truncated ? `first ${String(MAX_ROWS)}` : 'all'],
          ]}
        />

        {view === 'json' ? (
          <JsonPane
            title={`application/json · 200 OK${data.truncated ? ` · trimmed to ${String(MAX_ROWS)} models` : ''}`}
            json={jsonBody}
            note={
              <>
                identical body to{' '}
                <code>curl https://modelschemas.com{apiPath}</code>
                {data.truncated ? ' — the API returns the full list' : null}
              </>
            }
          />
        ) : (
          <>
            <div className="mb-3.5 flex flex-wrap items-center gap-2 font-mono text-xs">
              <select
                aria-label="Filter by provider"
                className={selectClasses}
                value={search.provider ?? ''}
                onChange={(event) => {
                  setSearch({ provider: event.target.value || undefined })
                }}
              >
                <option value="">provider=any</option>
                {data.providers.map((p) => (
                  <option key={p} value={p}>
                    provider={p}
                  </option>
                ))}
              </select>
              <select
                aria-label="Filter by activity"
                className={selectClasses}
                value={search.activity ?? ''}
                onChange={(event) => {
                  setSearch({
                    activity: (event.target.value || undefined) as
                      | Activity
                      | undefined,
                  })
                }}
              >
                <option value="">activity=any</option>
                {activities.map((a) => (
                  <option key={a} value={a}>
                    activity={a}
                  </option>
                ))}
              </select>
              <form
                className="contents"
                onSubmit={(event) => {
                  event.preventDefault()
                  setSearch({ q: q || undefined })
                }}
              >
                <input
                  aria-label="Filter models by text"
                  className={`${selectClasses} w-52`}
                  placeholder="q=filter models…"
                  value={q}
                  onChange={(event) => setQ(event.target.value)}
                  onBlur={() => setSearch({ q: q || undefined })}
                />
              </form>
            </div>

            <div className="figure overflow-x-auto">
              <table className="dtable">
                <thead>
                  <tr>
                    <th>model id</th>
                    <th>display name</th>
                    <th className="max-sm:hidden">activity</th>
                    <th className="num">first seen</th>
                    <th className="num">last seen</th>
                    <th aria-label="links" />
                  </tr>
                </thead>
                <tbody>
                  {data.models.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="text-ink-faint">
                        No models match these filters — clear a filter or
                        broaden <code>q</code>.
                      </td>
                    </tr>
                  ) : (
                    data.models.map((m) => (
                      <tr key={m.id}>
                        <td className="font-mono text-[12.5px]">
                          <a
                            className="font-medium text-ink hover:text-tok-blue"
                            href={modelHref(m)}
                          >
                            {m.rawId}
                          </a>
                        </td>
                        <td>{m.displayName ?? '—'}</td>
                        <td className="font-mono text-xs text-ink-soft max-sm:hidden">
                          {m.activity ?? '—'}
                        </td>
                        <td className="num text-ink-faint">
                          {shortDate(m.firstSeenAt)}
                        </td>
                        <td className="num text-ink-faint">
                          {timeAgo(m.lastSeenAt)}
                        </td>
                        <td className="font-mono text-xs">
                          <a className="press-link" href={modelHref(m)}>
                            detail →
                          </a>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            {data.truncated ? (
              <p className="mt-2.5 font-mono text-xs text-ink-faint">
                showing {MAX_ROWS} of {data.count} — narrow with the filters
                above, or fetch the full list from{' '}
                <a className="press-link" href={apiPath}>
                  {apiPath}
                </a>
              </p>
            ) : null}
          </>
        )}
      </main>
      <SiteFooter />
    </div>
  )
}
