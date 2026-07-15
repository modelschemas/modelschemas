import { createFileRoute } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { getVideoCatalog, validateVideoRequest } from '../server/api'
import type { ValidationOutcome, VideoModelEntry } from '../server/api'
import { clampOption, setAtPath } from '../lib/video'
import type { JsonObject, PickOption } from '../lib/video'

export const Route = createFileRoute('/')({
  loader: () => getVideoCatalog(),
  component: Composer,
})

function entryKey(entry: VideoModelEntry): string {
  return `${entry.provider}/${entry.endpointId}`
}

function Composer() {
  const catalog = Route.useLoaderData()
  const [query, setQuery] = useState('')
  const [provider, setProvider] = useState<string | null>(null)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [aspectLabel, setAspectLabel] = useState<string | null>(null)
  const [durationLabel, setDurationLabel] = useState<string | null>(null)
  const [rangeSeconds, setRangeSeconds] = useState<number | null>(null)
  const [resolutionLabel, setResolutionLabel] = useState<string | null>(null)
  const [prompt, setPrompt] = useState(
    'A slow dolly shot across a rain-soaked neon alley, reflections rippling',
  )
  const [verdict, setVerdict] = useState<ValidationOutcome | null>(null)
  const [checking, setChecking] = useState(false)

  const providers = useMemo(() => {
    const counts = new Map<string, number>()
    for (const entry of catalog.entries)
      counts.set(entry.provider, (counts.get(entry.provider) ?? 0) + 1)
    return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [catalog.entries])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return catalog.entries.filter((entry) => {
      if (provider !== null && entry.provider !== provider) return false
      if (needle === '') return true
      return (
        entry.provider.toLowerCase().includes(needle) ||
        entry.endpointId.toLowerCase().includes(needle) ||
        shortName(entry).toLowerCase().includes(needle)
      )
    })
  }, [catalog.entries, query, provider])

  const selected =
    filtered.find((entry) => entryKey(entry) === selectedKey) ??
    filtered[0] ??
    catalog.entries[0]

  // Schema-clamped effective choices: a remembered pick survives a model
  // switch only when the new schema also allows it.
  const aspect =
    selected?.controls.aspect != null
      ? clampOption(selected.controls.aspect.options, aspectLabel)
      : undefined
  const duration = selected?.controls.duration
  const durationPick =
    duration?.kind === 'enum'
      ? clampOption(duration.options, durationLabel)
      : undefined
  const effectiveSeconds =
    duration?.kind === 'range'
      ? clamp(
          rangeSeconds ?? duration.defaultValue ?? duration.min ?? 1,
          duration.min,
          duration.max,
        )
      : null
  const resolution =
    selected?.controls.resolution != null
      ? clampOption(selected.controls.resolution.options, resolutionLabel)
      : undefined

  const payload = useMemo(() => {
    if (selected === undefined) return {}
    let out: JsonObject = {}
    const { controls } = selected
    if (controls.modelField !== null)
      out = setAtPath(out, controls.modelField.path, controls.modelField.value)
    if (controls.promptPath !== null)
      out = setAtPath(out, controls.promptPath, prompt)
    if (controls.aspect !== null && aspect !== undefined)
      out = setAtPath(out, controls.aspect.path, aspect.value)
    if (duration?.kind === 'enum' && durationPick !== undefined)
      out = setAtPath(out, duration.path, durationPick.value)
    if (duration?.kind === 'range' && effectiveSeconds !== null)
      out = setAtPath(out, duration.path, effectiveSeconds)
    if (controls.resolution !== null && resolution !== undefined)
      out = setAtPath(out, controls.resolution.path, resolution.value)
    return out
  }, [
    selected,
    prompt,
    aspect,
    duration,
    durationPick,
    effectiveSeconds,
    resolution,
  ])

  if (selected === undefined) {
    return (
      <main className="suite">
        <Masthead count={0} baseUrl={catalog.baseUrl} />
        <div className="suite-empty">
          <p>
            No video schemas with composable controls found at{' '}
            <code>{catalog.baseUrl}</code>. Sync a provider with video endpoints
            (OpenRouter ships per-model video schemas), then reload.
          </p>
        </div>
      </main>
    )
  }

  const pick = (entry: VideoModelEntry) => {
    setSelectedKey(entryKey(entry))
    setVerdict(null)
  }

  const validate = () => {
    setChecking(true)
    setVerdict(null)
    validateVideoRequest({
      data: {
        provider: selected.provider,
        endpointId: selected.endpointId,
        payload,
      },
    })
      .then(setVerdict)
      .catch(() => {
        setVerdict({
          valid: false,
          errors: [],
          failure: 'validation request failed',
        })
      })
      .finally(() => {
        setChecking(false)
      })
  }

  return (
    <main className="suite">
      <Masthead count={catalog.entries.length} baseUrl={catalog.baseUrl} />

      <div className="suite-grid">
        <nav className="bin" aria-label="video models">
          <p className="bin-label">
            models / {filtered.length}
            {filtered.length !== catalog.entries.length
              ? ` of ${catalog.entries.length}`
              : ''}
          </p>
          <input
            type="search"
            className="bin-search"
            placeholder="search models…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {providers.length > 1 && (
            <div className="bin-chips" role="group" aria-label="providers">
              <button
                type="button"
                className={
                  provider === null ? 'bin-chip bin-chip-on' : 'bin-chip'
                }
                onClick={() => setProvider(null)}
              >
                all
              </button>
              {providers.map(([name, count]) => (
                <button
                  key={name}
                  type="button"
                  className={
                    provider === name ? 'bin-chip bin-chip-on' : 'bin-chip'
                  }
                  onClick={() => setProvider(provider === name ? null : name)}
                >
                  {name} {count}
                </button>
              ))}
            </div>
          )}
          {filtered.length === 0 && (
            <p className="bin-empty">nothing matches</p>
          )}
          {filtered.map((entry) => {
            const key = entryKey(entry)
            const active = key === entryKey(selected)
            return (
              <button
                key={key}
                type="button"
                className={active ? 'bin-row bin-row-on' : 'bin-row'}
                onClick={() => pick(entry)}
              >
                <span className="bin-provider">{entry.provider}</span>
                <span className="bin-name">{shortName(entry)}</span>
                <span className="bin-meta">
                  {entry.controls.aspect !== null
                    ? `${String(entry.controls.aspect.options.length)} ratios`
                    : '· '}
                  {' · '}
                  {entry.controls.duration?.kind === 'enum'
                    ? `${String(entry.controls.duration.options.length)} durations`
                    : entry.controls.duration?.kind === 'range'
                      ? 'free length'
                      : ''}
                </span>
              </button>
            )
          })}
        </nav>

        <section className="deck" aria-label="composer">
          <header className="deck-head">
            <p className="deck-provider">{selected.provider}</p>
            <h2 className="deck-title">{shortName(selected)}</h2>
            <p className="deck-endpoint">{selected.endpointId}</p>
          </header>

          {selected.controls.aspect !== null && aspect !== undefined && (
            <div className="knob">
              <p className="knob-label">
                aspect ratio
                <span className="knob-note">
                  {selected.controls.aspect.options.length} allowed
                </span>
              </p>
              <div className="gate-row">
                {selected.controls.aspect.options.map((option) => (
                  <GateBox
                    key={option.label}
                    option={option}
                    active={option.label === aspect.label}
                    onPick={() => {
                      setAspectLabel(option.label)
                      setVerdict(null)
                    }}
                  />
                ))}
              </div>
            </div>
          )}

          {duration !== undefined && duration !== null && (
            <div className="knob">
              <p className="knob-label">
                duration
                <span className="knob-note">
                  {duration.kind === 'enum'
                    ? `${String(duration.options.length)} allowed`
                    : `${String(duration.min ?? '?')}–${String(duration.max ?? '?')}s`}
                </span>
              </p>
              {duration.kind === 'enum' ? (
                <div className="seg-row">
                  {duration.options.map((option) => (
                    <button
                      key={option.label}
                      type="button"
                      className={
                        option.label === durationPick?.label
                          ? 'seg seg-on'
                          : 'seg'
                      }
                      onClick={() => {
                        setDurationLabel(option.label)
                        setVerdict(null)
                      }}
                    >
                      {option.label}s
                    </button>
                  ))}
                </div>
              ) : (
                <div className="length-rail">
                  <input
                    type="range"
                    min={duration.min ?? 1}
                    max={duration.max ?? 60}
                    step={1}
                    value={effectiveSeconds ?? 1}
                    onChange={(event) => {
                      setRangeSeconds(Number(event.target.value))
                      setVerdict(null)
                    }}
                  />
                  <span className="length-readout">
                    {String(effectiveSeconds ?? '—')}s
                  </span>
                </div>
              )}
            </div>
          )}

          {selected.controls.resolution !== null &&
            resolution !== undefined && (
              <div className="knob">
                <p className="knob-label">resolution</p>
                <div className="seg-row">
                  {selected.controls.resolution.options.map((option) => (
                    <button
                      key={option.label}
                      type="button"
                      className={
                        option.label === resolution.label ? 'seg seg-on' : 'seg'
                      }
                      onClick={() => {
                        setResolutionLabel(option.label)
                        setVerdict(null)
                      }}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

          <div className="knob">
            <p className="knob-label">prompt</p>
            <textarea
              className="prompt-input"
              rows={3}
              value={prompt}
              onChange={(event) => {
                setPrompt(event.target.value)
                setVerdict(null)
              }}
            />
          </div>
        </section>

        <aside className="readout" aria-label="request">
          <div className="readout-head">
            <p className="bin-label">request</p>
            <button
              type="button"
              className="validate-button"
              disabled={checking}
              onClick={validate}
            >
              {checking ? 'validating…' : 'validate against schema'}
            </button>
          </div>
          <pre className="readout-json">{JSON.stringify(payload, null, 2)}</pre>
          {verdict !== null && (
            <div
              className={
                verdict.valid ? 'verdict verdict-ok' : 'verdict verdict-bad'
              }
              role="status"
            >
              {verdict.valid ? (
                <p className="verdict-line">✓ valid per current schema</p>
              ) : verdict.failure !== null ? (
                <p className="verdict-line">✕ {verdict.failure}</p>
              ) : (
                <>
                  <p className="verdict-line">
                    ✕ {verdict.errors.length} schema violation
                    {verdict.errors.length === 1 ? '' : 's'}
                  </p>
                  <ul className="verdict-list">
                    {verdict.errors.slice(0, 6).map((error, index) => (
                      <li key={index}>
                        <code>{error.path === '' ? '#' : error.path}</code>{' '}
                        {error.message}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
        </aside>
      </div>
    </main>
  )
}

function Masthead({ count, baseUrl }: { count: number; baseUrl: string }) {
  return (
    <header className="masthead">
      <p className="masthead-kicker">
        @modelschemas/client · live video schemas
      </p>
      <h1 className="masthead-title">
        video<span className="masthead-tick">▮</span>composer
      </h1>
      <p className="masthead-note">
        {count} video model{count === 1 ? '' : 's'} from <code>{baseUrl}</code>.
        Every knob below offers only the values its schema allows — switch
        models and the picks re-clamp.
      </p>
    </header>
  )
}

function GateBox({
  option,
  active,
  onPick,
}: {
  option: PickOption
  active: boolean
  onPick: () => void
}) {
  const ratio = parseRatio(option.label) ?? 1
  const height = 52
  const width = Math.min(120, Math.max(24, height * ratio))
  return (
    <button
      type="button"
      className={active ? 'gate gate-on' : 'gate'}
      onClick={onPick}
    >
      <span
        className="gate-frame"
        style={{ width: `${String(width)}px`, height: `${String(height)}px` }}
      />
      <span className="gate-label">
        {option.label}
        {option.isDefault ? ' •' : ''}
      </span>
    </button>
  )
}

function parseRatio(label: string): number | undefined {
  const match = /^(\d{1,2})\s*:\s*(\d{1,2})$/.exec(label)
  if (match?.[1] === undefined || match[2] === undefined) return undefined
  const h = Number(match[2])
  return h > 0 ? Number(match[1]) / h : undefined
}

function clamp(
  value: number,
  min: number | undefined,
  max: number | undefined,
): number {
  let out = value
  if (min !== undefined) out = Math.max(min, out)
  if (max !== undefined) out = Math.min(max, out)
  return out
}

function shortName(entry: VideoModelEntry): string {
  const value = entry.controls.modelField?.value
  if (typeof value === 'string') return value
  return entry.endpointId.replace(/^videos\//, '')
}
