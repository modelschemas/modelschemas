import { useState } from 'react'
import { createFileRoute, notFound } from '@tanstack/react-router'
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
  StatusDot,
  ViewToggle,
} from '#/components/site.tsx'
import type { ResourceView } from '#/components/site.tsx'
import type { SerializableModel } from '#/lib/json.ts'
import { timeAgo, shortDate } from '#/lib/time.ts'

interface EndpointLink {
  activity: string
  endpointId: string
}

/** Keep path slashes but escape `?`/`#` — endpoint ids may contain them. */
function endpointPath(endpointId: string): string {
  return endpointId.split('/').map(encodeURIComponent).join('/')
}

interface PricingView {
  compact: {
    per: string
    inputPerMillion?: number
    outputPerMillion?: number
    tiered?: true
  }
  sourceUrl: string | null
  inputs: Array<string>
  examples: Array<{ usd: number; quote: string }>
}

interface ModelDetailData {
  model: SerializableModel
  pricing: PricingView | null
  providerStatus: string
  /** Provider endpoints; for huge providers (FAL) filtered to this model. */
  endpoints: Array<EndpointLink>
  endpointsFiltered: boolean
}

const getModelDetail = createServerFn({ method: 'GET' })
  .inputValidator((params: { provider: string; modelId: string }) => params)
  .handler(async ({ data }): Promise<ModelDetailData | null> => {
    const { env } = await import('cloudflare:workers')
    const { getDb } = await import('#/db/index.ts')
    const { getModelDetail: getModel } = await import('#/server/catalog.ts')
    const { getProviderSchemaIndex } = await import('#/server/schemas-api.ts')
    const { getServiceStatus } = await import('#/server/status.ts')

    const db = getDb(env)
    const model = await getModel(db, data.provider, data.modelId)
    if (!model) return null
    const { parseStoredRateCard, projectTokenPricing } =
      await import('#/server/rate-card.ts')
    const card = parseStoredRateCard(model.pricing)
    const pricing: PricingView | null =
      card === null
        ? null
        : {
            compact: projectTokenPricing(card),
            sourceUrl: card.source.url,
            inputs: Object.values(card.inputs).map(
              (input) => `${input.param} (${input.bound ?? 'request'})`,
            ),
            examples: card.examples.map((example) => ({
              usd: example.usd,
              quote: example.quote,
            })),
          }
    const [index, status] = await Promise.all([
      getProviderSchemaIndex(db, data.provider),
      getServiceStatus(db),
    ])

    const all: Array<EndpointLink> = Object.entries(index.activities).flatMap(
      ([activity, ids]) => ids.map((endpointId) => ({ activity, endpointId })),
    )
    const boundId =
      typeof model.schemaEndpointId === 'string' ? model.schemaEndpointId : null
    // Prefer the bound generation route; aggregator providers (FAL) match
    // on rawId. Fall back to the provider's first 40 endpoints.
    const matching = boundId
      ? all.filter((e) => e.endpointId === boundId)
      : all.filter((e) => e.endpointId.includes(model.rawId))
    const endpointsFiltered =
      matching.length > 0 && matching.length < all.length
    return {
      // drizzle json columns are typed unknown; the values are plain JSON
      model: model as unknown as SerializableModel,
      pricing,
      providerStatus:
        status.providers.find((p) => p.id === data.provider)?.status ??
        'unknown',
      endpoints: endpointsFiltered ? matching : all.slice(0, 40),
      endpointsFiltered,
    }
  })

export const Route = createFileRoute('/models/$provider/$modelId')({
  loader: async ({ params }) => {
    const data = await getModelDetail({ data: params })
    if (data === null) throw notFound()
    return data
  },
  component: ModelDetail,
})

function formatUsd(n: number): string {
  if (Number.isInteger(n)) return `$${String(n)}`
  const fixed = n >= 0.01 ? n.toFixed(4) : n.toFixed(6)
  return `$${fixed.replace(/0+$/, '').replace(/\.$/, '')}`
}

function ModelDetail() {
  const { model, pricing, providerStatus, endpoints, endpointsFiltered } =
    Route.useLoaderData()
  const [view, setView] = useState<ResourceView>('readable')

  const apiPath = `/v1/models/${model.provider}/${model.rawId.includes('/') ? model.id : model.rawId}`
  const jsonBody = JSON.stringify(model, null, 2)
  const firstEndpoint = endpoints.at(0)
  const schemaCurl = firstEndpoint
    ? `curl https://modelschemas.com/v1/schemas/${model.provider}/${firstEndpoint.activity}/${encodeURIComponent(firstEndpoint.endpointId)}`
    : `curl https://modelschemas.com/v1/schemas/${model.provider}`

  const richness: Array<[string, unknown]> = [
    ['contextWindow', model.contextWindow],
    ['maxOutput', model.maxOutput],
    ['modalities', model.modalities],
    ['capabilities', model.capabilities],
  ]
  const published = richness.filter(([, v]) => v !== null && v !== undefined)
  const unpublished = richness.filter(([, v]) => v === null || v === undefined)

  return (
    <div className="min-h-screen text-ink">
      <SiteNav active="models" />
      <main className="mx-auto max-w-[1080px] px-6 pb-16">
        <ReqLine
          path={
            <>
              /v1/models/{model.provider}/
              <span className="text-tok-blue">
                {model.rawId.includes('/') ? model.id : model.rawId}
              </span>
            </>
          }
          copyUrl={`https://modelschemas.com${apiPath}`}
          right={<ViewToggle view={view} onChange={setView} />}
        />
        <MetaStrip
          items={[
            [
              'provider',
              <a
                key="p"
                className="press-link"
                href={`/models?provider=${model.provider}`}
              >
                {model.provider}
              </a>,
            ],
            ['status', <StatusDot key="s" status={providerStatus} />],
            ['first seen', shortDate(model.firstSeenAt)],
            ['last seen', timeAgo(model.lastSeenAt)],
            ...(model.deprecatedAt
              ? ([
                  [
                    'deprecated',
                    <span key="d" className="text-tok-red">
                      {shortDate(model.deprecatedAt)}
                    </span>,
                  ],
                ] as Array<[string, React.ReactNode]>)
              : []),
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
                <tbody>
                  <tr>
                    <td className="w-44 font-mono text-xs text-ink-faint">
                      rawId
                    </td>
                    <td className="font-mono text-[12.5px] font-semibold">
                      {model.rawId}{' '}
                      <CopyButton text={model.rawId} className="ml-1" />
                    </td>
                  </tr>
                  <tr>
                    <td className="font-mono text-xs text-ink-faint">
                      displayName
                    </td>
                    <td>{model.displayName ?? '—'}</td>
                  </tr>
                  <tr>
                    <td className="font-mono text-xs text-ink-faint">id</td>
                    <td className="font-mono text-[12.5px]">{model.id}</td>
                  </tr>
                  <tr>
                    <td className="font-mono text-xs text-ink-faint">
                      activity
                    </td>
                    <td className="font-mono text-[12.5px]">
                      {model.activity ?? (
                        <span className="text-ink-faint">
                          not declared by the provider
                        </span>
                      )}
                    </td>
                  </tr>
                  <tr>
                    <td className="font-mono text-xs text-ink-faint">
                      schemaEndpointId
                    </td>
                    <td className="font-mono text-[12.5px]">
                      {model.schemaEndpointId ?? (
                        <span className="text-ink-faint">
                          no bound generation route
                        </span>
                      )}
                    </td>
                  </tr>
                  <tr>
                    <td className="font-mono text-xs text-ink-faint">
                      firstSeenAt
                    </td>
                    <td className="font-mono text-[12.5px]">
                      {model.firstSeenAt}{' '}
                      <span className="text-ink-faint">
                        — {shortDate(model.firstSeenAt)}
                      </span>
                    </td>
                  </tr>
                  <tr>
                    <td className="font-mono text-xs text-ink-faint">
                      lastSeenAt
                    </td>
                    <td className="font-mono text-[12.5px]">
                      {model.lastSeenAt}{' '}
                      <span className="text-ink-faint">
                        — {timeAgo(model.lastSeenAt)}
                      </span>
                    </td>
                  </tr>
                  <tr>
                    <td className="font-mono text-xs text-ink-faint">
                      pricing
                    </td>
                    <td className="font-mono text-[12.5px]">
                      {pricing === null ? (
                        <span className="text-ink-faint">
                          not published by this provider’s list endpoint
                        </span>
                      ) : (
                        <div className="space-y-1">
                          {pricing.compact.inputPerMillion !== undefined ? (
                            <div>
                              {formatUsd(pricing.compact.inputPerMillion)} / 1M
                              input
                              {pricing.compact.outputPerMillion !== undefined
                                ? ` · ${formatUsd(pricing.compact.outputPerMillion)} / 1M output`
                                : ''}
                              {pricing.compact.tiered
                                ? ' · base rate; long prompts re-quote'
                                : ''}
                            </div>
                          ) : (
                            <div>rate card, per {pricing.compact.per}</div>
                          )}
                          {pricing.sourceUrl ? (
                            <div>
                              <a
                                className="press-link"
                                href={pricing.sourceUrl}
                              >
                                {pricing.sourceUrl}
                              </a>
                            </div>
                          ) : null}
                          {pricing.inputs.length > 0 ? (
                            <div className="text-ink-faint">
                              {pricing.inputs.join(' · ')}
                            </div>
                          ) : null}
                          {pricing.examples.map((example) => (
                            <div key={example.quote}>
                              {formatUsd(example.usd)} — {example.quote}
                            </div>
                          ))}
                        </div>
                      )}
                    </td>
                  </tr>
                  {published.map(([key, value]) => (
                    <tr key={key}>
                      <td className="font-mono text-xs text-ink-faint">
                        {key}
                      </td>
                      <td className="font-mono text-[12.5px]">
                        {JSON.stringify(value)}
                      </td>
                    </tr>
                  ))}
                  {unpublished.length > 0 ? (
                    <tr>
                      <td className="font-mono text-xs text-ink-faint">
                        {unpublished.map(([key]) => key).join(' · ')}
                      </td>
                      <td className="text-[12.5px] text-ink-faint">
                        not published by this provider’s list endpoint
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>

            <SectionHead
              title="Endpoints & schemas"
              aside={
                <a
                  className="press-link"
                  href={`/v1/schemas/${model.provider}`}
                >
                  GET /v1/schemas/{model.provider} →
                </a>
              }
            />
            {endpoints.length === 0 ? (
              <p className="font-mono text-sm text-ink-faint">
                no schemas synced for this provider yet — check{' '}
                <a className="press-link" href="/v1/status">
                  /v1/status
                </a>
              </p>
            ) : (
              <>
                <div className="figure overflow-x-auto">
                  <table className="dtable">
                    <thead>
                      <tr>
                        <th>endpoint</th>
                        <th>activity</th>
                        <th>schemas</th>
                      </tr>
                    </thead>
                    <tbody>
                      {endpoints.map((e) => (
                        <tr key={`${e.activity}:${e.endpointId}`}>
                          <td className="font-mono text-[12.5px]">
                            {e.endpointId}
                          </td>
                          <td className="font-mono text-xs text-ink-soft">
                            {e.activity}
                          </td>
                          <td className="font-mono text-xs">
                            <a
                              className="press-link"
                              href={`/schemas/${model.provider}/${e.activity}/${endpointPath(e.endpointId)}`}
                            >
                              request<span className="kindtag in">input</span>
                            </a>{' '}
                            <a
                              className="press-link ml-2"
                              href={`/schemas/${model.provider}/${e.activity}/${endpointPath(e.endpointId)}?kind=output`}
                            >
                              response
                              <span className="kindtag out">output</span>
                            </a>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {endpointsFiltered ? (
                  <p className="mt-2.5 font-mono text-xs text-ink-faint">
                    endpoints matching this model — the provider has more, see{' '}
                    <a
                      className="press-link"
                      href={`/v1/schemas/${model.provider}`}
                    >
                      /v1/schemas/{model.provider}
                    </a>
                  </p>
                ) : null}
              </>
            )}

            <SectionHead title="Use it" />
            <CodePanel title="shell" copyText={schemaCurl}>
              <code>
                <span className="prompt">$</span> {schemaCurl}{' '}
                <span className="cj-dim"># request schema</span>
                {'\n'}
                <span className="prompt">$</span> curl -X POST
                https://modelschemas.com/v1/validate -d{' '}
                <span className="cj-str">
                  {`'{"provider":"${model.provider}","endpointId":"${firstEndpoint?.endpointId ?? '…'}","payload":{…}}'`}
                </span>
                {'\n'}
                <span className="prompt">$</span> curl -X POST
                https://modelschemas.com/v1/estimate -d{' '}
                <span className="cj-str">
                  {`'{"provider":"${model.provider}","model":"${model.rawId}","usage":{"input_tokens":1200,"output_tokens":400}}'`}
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
