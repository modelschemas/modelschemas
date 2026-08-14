import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'
import { JsonView, SchemaForm } from '../components/SchemaForm'
import { isSchemaNode, seedValue } from '../lib/jsonschema'
import type { JsonValue, SchemaNode } from '../lib/jsonschema'

// Pulled by @modelschemas/vite at dev time, committed, verified at build.
import { anthropicV1MessagesRequestSchema } from '../modelschemas/anthropic/v1-messages.request'
import { openrouterChatCompletionsRequestSchema } from '../modelschemas/openrouter/chat-completions.request'
import { openrouterVideosGoogleVeo31RequestSchema } from '../modelschemas/openrouter/videos-google-veo-3.1.request'
import { openrouterAudioSpeechRequestSchema } from '../modelschemas/openrouter/audio-speech.request'

export const Route = createFileRoute('/')({
  component: SchemaStudio,
})

interface Entry {
  id: string
  provider: string
  endpoint: string
  schema: SchemaNode
}

const PINNED: Array<Entry> = [
  {
    id: 'anthropic-messages',
    provider: 'anthropic',
    endpoint: 'v1/messages',
    schema: anthropicV1MessagesRequestSchema,
  },
  {
    id: 'openrouter-chat',
    provider: 'openrouter',
    endpoint: 'chat/completions',
    schema: openrouterChatCompletionsRequestSchema,
  },
  {
    id: 'openrouter-veo',
    provider: 'openrouter',
    endpoint: 'videos/google/veo-3.1',
    schema: openrouterVideosGoogleVeo31RequestSchema,
  },
  {
    id: 'openrouter-speech',
    provider: 'openrouter',
    endpoint: 'audio/speech',
    schema: openrouterAudioSpeechRequestSchema,
  },
]

/** Same-origin on modelschemas.com (the example is zone-routed); the prod
 * API (CORS-open reads) from a local dev server. */
const API_BASE =
  typeof window !== 'undefined' &&
  /^(localhost|127\.|0\.0\.0\.0)/.test(window.location.hostname)
    ? 'https://modelschemas.com'
    : ''

interface LiveEndpoint {
  provider: string
  activity: string
  endpointId: string
}

interface SchemaIndexResponse {
  count: number
  providers: Array<{
    provider: string
    count: number
    activities: Record<string, Array<string>>
  }>
}

function flattenIndex(index: SchemaIndexResponse): Array<LiveEndpoint> {
  const rows: Array<LiveEndpoint> = []
  for (const group of index.providers) {
    for (const [activity, ids] of Object.entries(group.activities)) {
      for (const endpointId of ids) {
        rows.push({ provider: group.provider, activity, endpointId })
      }
    }
  }
  return rows
}

function liveKey(endpoint: LiveEndpoint): string {
  return `live:${endpoint.provider}/${endpoint.activity}/${endpoint.endpointId}`
}

function schemaUrl(endpoint: LiveEndpoint): string {
  return `${API_BASE}/v1/schemas/${endpoint.provider}/${endpoint.activity}/${encodeURIComponent(endpoint.endpointId)}`
}

function SchemaStudio() {
  // The full live index: every schema on the system, fetched once.
  const [index, setIndex] = useState<SchemaIndexResponse | null>(null)
  const [indexError, setIndexError] = useState(false)
  const [liveProvider, setLiveProvider] = useState('')
  const [activeId, setActiveId] = useState(PINNED[0]?.id ?? '')
  // Fetched live schemas by liveKey; null while in flight.
  const [liveSchemas, setLiveSchemas] = useState<
    Record<string, SchemaNode | null>
  >({})
  const [values, setValues] = useState<Record<string, JsonValue>>({})
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch(`${API_BASE}/v1/schemas`)
      .then((response) => response.json() as Promise<SchemaIndexResponse>)
      .then((body) => {
        if (!cancelled && Array.isArray(body.providers)) setIndex(body)
      })
      .catch(() => {
        if (!cancelled) setIndexError(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const liveEndpoints = useMemo(
    () => (index === null ? [] : flattenIndex(index)),
    [index],
  )
  const providerIds = useMemo(
    () => (index === null ? [] : index.providers.map((p) => p.provider)),
    [index],
  )
  const railEndpoints = useMemo(() => {
    if (liveProvider === '') return []
    return liveEndpoints.filter((e) => e.provider === liveProvider)
  }, [liveEndpoints, liveProvider])

  const selectLive = (endpoint: LiveEndpoint) => {
    const key = liveKey(endpoint)
    setActiveId(key)
    if (key in liveSchemas) return
    setLiveSchemas((prev) => ({ ...prev, [key]: null }))
    fetch(schemaUrl(endpoint))
      .then((response) => response.json() as Promise<{ schema?: unknown }>)
      .then((body) => {
        if (isSchemaNode(body.schema)) {
          const schema = body.schema
          setLiveSchemas((prev) => ({ ...prev, [key]: schema }))
        }
      })
      .catch(() => undefined)
  }

  const active: Entry | undefined = useMemo(() => {
    const pinned = PINNED.find((entry) => entry.id === activeId)
    if (pinned) return pinned
    if (!activeId.startsWith('live:')) return PINNED[0]
    const schema = liveSchemas[activeId]
    if (schema === null || schema === undefined) return undefined
    const [provider = '', , ...rest] = activeId.slice('live:'.length).split('/')
    return {
      id: activeId,
      provider,
      endpoint: rest.join('/'),
      schema,
    }
  }, [activeId, liveSchemas])

  const fallback = useMemo(
    () =>
      active === undefined ? null : seedValue(active.schema, active.schema),
    [active],
  )
  const value =
    active === undefined ? null : (values[active.id] ?? fallback ?? null)

  const setValue = (next: JsonValue) => {
    if (active === undefined) return
    setValues((prev) => ({ ...prev, [active.id]: next }))
  }

  return (
    <main className="studio">
      <header className="masthead">
        <p className="masthead-kicker">@modelschemas/vite · generative UI</p>
        <h1 className="masthead-title">schema studio</h1>
        <p className="masthead-note">
          Every control below is generated at render time from a provider's live
          request schema. Four are pulled into the repo by the vite plugin and
          verified offline on build — and the browser reaches{' '}
          <a href={`${API_BASE}/v1/schemas`}>every schema on the system</a> over
          the live API.
        </p>
      </header>

      <div className="studio-grid">
        <nav className="rail" aria-label="schemas">
          <p className="rail-label">pinned · offline-verified</p>
          {PINNED.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={
                entry.id === activeId ? 'rail-card rail-card-on' : 'rail-card'
              }
              onClick={() => setActiveId(entry.id)}
            >
              <span className="rail-provider">{entry.provider}</span>
              <span className="rail-endpoint">{entry.endpoint}</span>
              <span className="rail-kind">#request</span>
            </button>
          ))}

          <p className="rail-label rail-live-label">
            live · all {index === null ? '' : `${index.count} `}schemas
          </p>
          {indexError ? (
            <p className="rail-note">
              couldn't reach the live index — pinned schemas still work offline.
            </p>
          ) : index === null ? (
            <p className="rail-note">loading /v1/schemas…</p>
          ) : (
            <>
              <select
                className="rail-select"
                aria-label="Browse a provider's schemas"
                value={liveProvider}
                onChange={(event) => setLiveProvider(event.target.value)}
              >
                <option value="">browse a provider…</option>
                {providerIds.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
              <div className="rail-scroll">
                {railEndpoints.map((endpoint) => {
                  const key = liveKey(endpoint)
                  return (
                    <button
                      key={key}
                      type="button"
                      className={
                        key === activeId
                          ? 'rail-card rail-card-on'
                          : 'rail-card'
                      }
                      onClick={() => selectLive(endpoint)}
                    >
                      <span className="rail-provider">{endpoint.activity}</span>
                      <span className="rail-endpoint">
                        {endpoint.endpointId}
                      </span>
                      <span className="rail-kind">#request</span>
                    </button>
                  )
                })}
              </div>
            </>
          )}
        </nav>

        {active === undefined ? (
          <section className="canvas" aria-label="generated form">
            <div className="canvas-head">
              <h2 className="canvas-title">fetching schema…</h2>
            </div>
            <p className="rail-note">
              pulling the live JSON Schema from {API_BASE || 'this origin'}
              /v1/schemas.
            </p>
          </section>
        ) : (
          <section className="canvas" aria-label="generated form">
            <div className="canvas-head">
              <h2 className="canvas-title">
                {active.provider} / {active.endpoint}
              </h2>
              <button
                type="button"
                className="ghost-button"
                onClick={() =>
                  setValue(seedValue(active.schema, active.schema))
                }
              >
                reset
              </button>
            </div>
            <SchemaForm
              schema={active.schema}
              value={value}
              onChange={setValue}
            />
          </section>
        )}

        <aside className="payload" aria-label="request payload">
          <div className="payload-head">
            <p className="rail-label">request payload</p>
            <button
              type="button"
              className="ghost-button"
              onClick={() => {
                navigator.clipboard
                  .writeText(JSON.stringify(value, null, 2))
                  .then(() => {
                    setCopied(true)
                    setTimeout(() => setCopied(false), 1200)
                  })
                  .catch(() => undefined)
              }}
            >
              {copied ? 'copied ✓' : 'copy'}
            </button>
          </div>
          <JsonView value={value} />
        </aside>
      </div>
    </main>
  )
}
