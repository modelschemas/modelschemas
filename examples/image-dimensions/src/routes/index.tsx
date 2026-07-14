import { createFileRoute } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { getImageCatalog } from '../lib/api'
import type { ImageModelEntry } from '../lib/api'
import type { AspectBox, SizeBox } from '../lib/dimensions'

export const Route = createFileRoute('/')({
  loader: () => getImageCatalog(),
  component: ContactSheet,
})

function ContactSheet() {
  const catalog = Route.useLoaderData()
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (needle === '') return catalog.entries
    return catalog.entries.filter(
      (entry) =>
        entry.endpointId.toLowerCase().includes(needle) ||
        entry.provider.toLowerCase().includes(needle) ||
        entry.report.modelIds.some((id) => id.toLowerCase().includes(needle)),
    )
  }, [catalog.entries, query])

  const selected =
    filtered.find((entry) => entryKey(entry) === selectedId) ?? filtered[0]

  const byProvider = useMemo(() => {
    const groups = new Map<string, Array<ImageModelEntry>>()
    for (const entry of filtered) {
      const group = groups.get(entry.provider) ?? []
      group.push(entry)
      groups.set(entry.provider, group)
    }
    return [...groups.entries()]
  }, [filtered])

  return (
    <main className="sheet">
      <header className="sheet-head">
        <div>
          <p className="kicker">@modelschemas/client · live catalog</p>
          <h1 className="display">
            Image <em>dimensions</em>
          </h1>
          <p className="standfirst">
            {catalog.entries.length} image endpoint
            {catalog.entries.length === 1 ? '' : 's'} discovered from{' '}
            <code>{catalog.baseUrl}</code> — supported output sizes extracted
            from each model's input schema and printed to scale.
          </p>
        </div>
        <input
          type="search"
          className="search"
          placeholder="filter models…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </header>

      {catalog.entries.length === 0 ? (
        <EmptyState baseUrl={catalog.baseUrl} swept={catalog.providers} />
      ) : (
        <div className="sheet-grid">
          <nav className="index" aria-label="image models">
            {byProvider.map(([provider, group]) => (
              <section key={provider}>
                <h2 className="index-provider">{provider}</h2>
                {group.map((entry) => {
                  const key = entryKey(entry)
                  const active =
                    selected !== undefined && entryKey(selected) === key
                  return (
                    <button
                      key={key}
                      type="button"
                      className={
                        active ? 'index-row index-row-on' : 'index-row'
                      }
                      onClick={() => setSelectedId(key)}
                    >
                      <span className="index-name">{entry.endpointId}</span>
                      <span className="index-count">
                        {entry.report.sizes.length > 0
                          ? `${String(entry.report.sizes.length)} sizes`
                          : entry.report.aspects.length > 0
                            ? `${String(entry.report.aspects.length)} ratios`
                            : entry.report.bounds !== null
                              ? 'free size'
                              : '—'}
                      </span>
                    </button>
                  )
                })}
              </section>
            ))}
            {filtered.length === 0 && (
              <p className="index-empty">nothing matches “{query}”</p>
            )}
          </nav>

          {selected !== undefined && <DetailPane entry={selected} />}
        </div>
      )}
    </main>
  )
}

function entryKey(entry: ImageModelEntry): string {
  return `${entry.provider}/${entry.endpointId}`
}

function DetailPane({ entry }: { entry: ImageModelEntry }) {
  const { report } = entry
  return (
    <article className="detail" key={entryKey(entry)}>
      <header className="detail-head">
        <p className="detail-provider">{entry.provider}</p>
        <h2 className="detail-title">{entry.endpointId}</h2>
        {report.modelIds.length > 0 && (
          <p className="detail-models">
            serves{' '}
            {report.modelIds.map((id) => (
              <code key={id}>{id}</code>
            ))}
          </p>
        )}
      </header>

      {report.sizes.length > 0 && (
        <section className="plate">
          <h3 className="plate-label">supported sizes</h3>
          <div className="size-board">
            {report.sizes.map((size) => (
              <SizeCard key={size.label} size={size} all={report.sizes} />
            ))}
          </div>
        </section>
      )}

      {report.aspects.length > 0 && (
        <section className="plate">
          <h3 className="plate-label">aspect ratios</h3>
          <div className="size-board">
            {report.aspects.map((aspect) => (
              <AspectCard key={aspect.label} aspect={aspect} />
            ))}
          </div>
        </section>
      )}

      {report.bounds !== null && (
        <section className="plate">
          <h3 className="plate-label">free dimensions</h3>
          <table className="bounds-table">
            <tbody>
              <tr>
                <th>width</th>
                <td>
                  {rangeText(report.bounds.minWidth, report.bounds.maxWidth)}
                </td>
                <td className="bounds-default">
                  {report.bounds.defaultWidth !== undefined
                    ? `default ${String(report.bounds.defaultWidth)}px`
                    : ''}
                </td>
              </tr>
              <tr>
                <th>height</th>
                <td>
                  {rangeText(report.bounds.minHeight, report.bounds.maxHeight)}
                </td>
                <td className="bounds-default">
                  {report.bounds.defaultHeight !== undefined
                    ? `default ${String(report.bounds.defaultHeight)}px`
                    : ''}
                </td>
              </tr>
            </tbody>
          </table>
        </section>
      )}

      {report.resolutions.length > 0 && (
        <section className="plate">
          <h3 className="plate-label">resolutions &amp; named modes</h3>
          <div className="res-row">
            {report.resolutions.map((resolution) => (
              <span key={resolution} className="res-chip">
                {resolution}
              </span>
            ))}
          </div>
        </section>
      )}

      {!report.hasAny && (
        <p className="detail-none">
          This schema declares no size, aspect-ratio, or width/height
          constraints — output dimensions are decided by the provider.
        </p>
      )}
    </article>
  )
}

const CELL = 132

function SizeCard({ size, all }: { size: SizeBox; all: Array<SizeBox> }) {
  const maxEdge = Math.max(...all.map((s) => Math.max(s.width, s.height)))
  const scale = CELL / maxEdge
  const w = Math.max(18, size.width * scale)
  const h = Math.max(18, size.height * scale)
  return (
    <figure
      className={size.isDefault ? 'size-card size-card-default' : 'size-card'}
    >
      <div className="size-stage" style={{ width: CELL, height: CELL }}>
        <div
          className="size-frame"
          style={{ width: `${String(w)}px`, height: `${String(h)}px` }}
        >
          {size.isDefault && <span className="size-flag">default</span>}
        </div>
      </div>
      <figcaption>
        <span className="size-name">{size.label}</span>
        <span className="size-dims">
          {size.kind === 'preset' &&
          size.label !== `${String(size.width)}x${String(size.height)}`
            ? `≈ ${String(size.width)}×${String(size.height)}`
            : `${String(size.width)}×${String(size.height)}`}
        </span>
      </figcaption>
    </figure>
  )
}

function AspectCard({ aspect }: { aspect: AspectBox }) {
  const area = CELL * CELL * 0.55
  const w = Math.sqrt(area * aspect.ratio)
  const h = w / aspect.ratio
  return (
    <figure
      className={aspect.isDefault ? 'size-card size-card-default' : 'size-card'}
    >
      <div className="size-stage" style={{ width: CELL, height: CELL }}>
        <div
          className="size-frame"
          style={{ width: `${String(w)}px`, height: `${String(h)}px` }}
        >
          {aspect.isDefault && <span className="size-flag">default</span>}
        </div>
      </div>
      <figcaption>
        <span className="size-name">{aspect.label}</span>
      </figcaption>
    </figure>
  )
}

function rangeText(min: number | undefined, max: number | undefined): string {
  if (min !== undefined && max !== undefined)
    return `${String(min)} – ${String(max)} px`
  if (max !== undefined) return `up to ${String(max)} px`
  if (min !== undefined) return `at least ${String(min)} px`
  return 'unconstrained'
}

function EmptyState({
  baseUrl,
  swept,
}: {
  baseUrl: string
  swept: Array<string>
}) {
  return (
    <div className="empty">
      <h2 className="empty-title">No image schemas synced yet</h2>
      <p>
        Swept {swept.length} provider{swept.length === 1 ? '' : 's'} at{' '}
        <code>{baseUrl}</code> and found no <code>image</code> activity schemas.
        Sync a provider with image endpoints, then reload:
      </p>
      <pre className="empty-code">
        {`curl -X POST ${baseUrl}/v1/admin/sync/fal -H "X-Admin-Key: $ADMIN_KEY"`}
      </pre>
    </div>
  )
}
