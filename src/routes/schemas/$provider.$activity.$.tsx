import { Fragment, useMemo, useState } from 'react'
import { createFileRoute, notFound, useNavigate } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'

import {
  CodePanel,
  CopyButton,
  JsonPane,
  MetaStrip,
  ReqLine,
  SectionHead,
  SiteFooter,
  SiteNav,
  ViewToggle,
} from '#/components/site.tsx'
import type { ResourceView } from '#/components/site.tsx'
import { schemaToRows } from '#/lib/schema-view.ts'
import type { PropRow } from '#/lib/schema-view.ts'
import type { Json } from '#/lib/json.ts'
import { shortDate } from '#/lib/time.ts'
import { activities } from '#/db/schema.ts'
import type { Activity } from '#/db/schema.ts'
import type { EndpointSchemaResult } from '#/server/schemas-api.ts'

type SchemaKind = 'input' | 'output'

/** EndpointSchemaResult with `schema: unknown` narrowed for serialization. */
type SerializableSchemaResult = Omit<EndpointSchemaResult, 'schema'> & {
  schema: Json
}

interface SchemaSearch {
  /** Absent means the default, `input` — keeps canonical URLs clean. */
  kind?: 'output'
  version?: string
}

const getSchema = createServerFn({ method: 'GET' })
  .inputValidator(
    (params: {
      provider: string
      activity: string
      endpointId: string
      kind: SchemaKind
      version?: string
    }) => params,
  )
  .handler(async ({ data }): Promise<SerializableSchemaResult | null> => {
    const { env } = await import('cloudflare:workers')
    const { getDb } = await import('#/db/index.ts')
    const { getEndpointSchema } = await import('#/server/schemas-api.ts')
    if (!(activities as ReadonlyArray<string>).includes(data.activity)) {
      return null
    }
    const result = await getEndpointSchema(
      getDb(env),
      data.provider,
      data.activity as Activity,
      data.endpointId,
      data.kind,
      data.version,
    )
    // stored schema text is parsed JSON, so the unknown really is Json
    return result as SerializableSchemaResult | null
  })

export const Route = createFileRoute('/schemas/$provider/$activity/$')({
  validateSearch: (search: Record<string, unknown>): SchemaSearch => ({
    kind: search.kind === 'output' ? 'output' : undefined,
    version:
      typeof search.version === 'string' && search.version !== ''
        ? search.version
        : undefined,
  }),
  loaderDeps: ({ search }) => search,
  loader: async ({ params, deps }) => {
    const result = await getSchema({
      data: {
        provider: params.provider,
        activity: params.activity,
        endpointId: params._splat ?? '',
        kind: deps.kind ?? 'input',
        version: deps.version,
      },
    })
    if (result === null) throw notFound()
    return result
  },
  component: SchemaDetail,
})

function PropRows({
  rows,
  depth,
  parentKey,
}: {
  rows: Array<PropRow>
  depth: number
  parentKey: string
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({})
  return (
    <>
      {rows.map((row) => {
        const key = `${parentKey}.${row.name}`
        const expandable = row.children.length > 0
        const isOpen = open[key] === true
        return (
          <Fragment key={key}>
            <tr
              className={
                expandable ? 'cursor-pointer hover:bg-paper-inset' : ''
              }
              onClick={
                expandable
                  ? () => setOpen((prev) => ({ ...prev, [key]: !isOpen }))
                  : undefined
              }
            >
              <td
                className="font-mono text-[13px] font-medium whitespace-nowrap"
                style={{ paddingLeft: `${String(14 + depth * 22)}px` }}
              >
                {expandable ? (
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${row.name}`}
                    className="mr-1.5 cursor-pointer border-none bg-transparent p-0 font-mono text-ink-faint"
                  >
                    {isOpen ? '▾' : '▸'}
                  </button>
                ) : null}
                {row.name}
                {row.required ? <span className="text-tok-red">*</span> : null}
              </td>
              <td>
                <span className={`ptype t-${row.typeClass}`}>
                  {row.typeLabel}
                </span>
              </td>
              <td className="max-w-[46em] text-[13px] text-ink-soft">
                {row.description ?? ''}
              </td>
              <td className="font-mono text-[11px] whitespace-nowrap text-ink-faint">
                {row.constraints.join(' · ')}
                {row.deprecated ? (
                  <span className="text-tok-red">
                    {row.constraints.length > 0 ? ' · ' : ''}deprecated
                  </span>
                ) : null}
              </td>
            </tr>
            {expandable && isOpen ? (
              <PropRows rows={row.children} depth={depth + 1} parentKey={key} />
            ) : null}
          </Fragment>
        )
      })}
    </>
  )
}

function SchemaDetail() {
  const result = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const [view, setView] = useState<ResourceView>('readable')

  const encodedId = encodeURIComponent(result.endpointId)
  const kindQuery = search.kind === 'output' ? '?kind=output' : ''
  const apiPath = `/v1/schemas/${result.provider}/${result.activity}/${encodedId}${kindQuery}`
  const jsonBody = useMemo(() => JSON.stringify(result, null, 2), [result])
  const table = useMemo(() => schemaToRows(result.schema), [result.schema])

  const validateCurl = `curl -X POST https://modelschemas.com/v1/validate -d '{"provider":"${result.provider}","endpointId":"${result.endpointId}","payload":{}}'`
  const sourceUrl = result.provenance.sourceUrl
  const jsonBytes = new Blob([jsonBody]).size

  return (
    <div className="min-h-screen text-ink">
      <SiteNav active="models" />
      <main className="mx-auto max-w-[1080px] px-6 pb-16">
        <ReqLine
          path={
            <>
              /v1/schemas/{result.provider}/{result.activity}/
              <span className="text-tok-blue">{encodedId}</span>
              {kindQuery === '' ? null : (
                <span className="text-ink-faint">{kindQuery}</span>
              )}
            </>
          }
          copyUrl={`https://modelschemas.com${apiPath}`}
          right={
            <div className="ml-auto flex flex-wrap items-center gap-2.5">
              <div className="seg">
                {(['input', 'output'] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    aria-pressed={(search.kind ?? 'input') === k}
                    onClick={() => {
                      void navigate({
                        search: (): SchemaSearch => ({
                          kind: k === 'output' ? 'output' : undefined,
                          version: undefined,
                        }),
                      })
                    }}
                  >
                    {k}
                  </button>
                ))}
              </div>
              <ViewToggle view={view} onChange={setView} />
            </div>
          }
        />
        <MetaStrip
          items={[
            ['kind', result.kind],
            [
              'activity',
              <a
                key="a"
                className="press-link"
                href={`/models?activity=${result.activity}&provider=${result.provider}`}
              >
                {result.activity}
              </a>,
            ],
            [
              'hash',
              <span key="h" className="inline-flex items-center gap-1.5">
                {result.contentHash.slice(0, 8)}…
                <CopyButton text={result.contentHash} />
              </span>,
            ],
            ['extracted', shortDate(result.createdAt)],
            [
              'version',
              result.supersededAt === null ? (
                'current'
              ) : (
                <span className="text-tok-amber">
                  superseded {shortDate(result.supersededAt)}
                </span>
              ),
            ],
            ...(sourceUrl?.startsWith('http')
              ? ([
                  [
                    'source',
                    <a key="s" className="press-link" href={sourceUrl}>
                      upstream spec ↗
                    </a>,
                  ],
                ] as Array<[string, React.ReactNode]>)
              : []),
          ]}
        />

        {view === 'json' ? (
          <JsonPane
            title={`application/json · 200 OK · ${String(Math.round(jsonBytes / 1024))} KB`}
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
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 pb-3">
              <h2 className="m-0 font-mono text-xs font-semibold tracking-[0.14em] text-ink uppercase">
                {result.kind === 'input' ? 'Request body' : 'Response body'}
              </h2>
              <span className="ml-auto font-mono text-[11.5px] text-ink-faint">
                {table.propertyCount} properties ·{' '}
                <span className="text-tok-red">
                  {table.requiredCount} required
                </span>{' '}
                · {table.defsCount} $defs
              </span>
            </div>

            {table.fallback ? (
              <div className="space-y-2.5">
                <p className="font-mono text-sm text-ink-faint">
                  This schema isn’t a plain object with properties — showing the
                  raw JSON instead.
                </p>
                <JsonPane title="application/json" json={jsonBody} />
              </div>
            ) : (
              <div className="figure overflow-x-auto">
                <table className="dtable">
                  <thead>
                    <tr>
                      <th className="w-56">property</th>
                      <th className="w-32">type</th>
                      <th className="min-w-[24em]">description</th>
                      <th>constraints</th>
                    </tr>
                  </thead>
                  <tbody>
                    <PropRows rows={table.rows} depth={0} parentKey="root" />
                  </tbody>
                </table>
              </div>
            )}

            <SectionHead
              title="Validate a payload"
              aside="before you spend tokens"
            />
            <CodePanel title="shell" copyText={validateCurl}>
              <code>
                <span className="prompt">$</span> curl -X POST
                https://modelschemas.com/v1/validate \{'\n    '}-d{' '}
                <span className="cj-str">
                  {`'{"provider":"${result.provider}","endpointId":"${result.endpointId}","payload":{…}}'`}
                </span>
                {'\n'}
                <span className="cj-dim">
                  {`→ {"valid": false, "errors": [{"path": "#", "keyword": "required", …}]}`}
                </span>
              </code>
            </CodePanel>
          </>
        )}
      </main>
      <SiteFooter />
    </div>
  )
}
