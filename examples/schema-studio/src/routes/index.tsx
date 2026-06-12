import { createFileRoute } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { JsonView, SchemaForm } from '../components/SchemaForm'
import { seedValue } from '../lib/jsonschema'
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

const ENTRIES: Array<Entry> = [
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

function SchemaStudio() {
  const [activeId, setActiveId] = useState(ENTRIES[0]?.id ?? '')
  const active = ENTRIES.find((entry) => entry.id === activeId) ?? ENTRIES[0]
  const [values, setValues] = useState<Record<string, JsonValue>>({})
  const [copied, setCopied] = useState(false)

  const fallback = useMemo(
    () =>
      active === undefined ? null : seedValue(active.schema, active.schema),
    [active],
  )
  if (active === undefined) return null
  const value = values[active.id] ?? fallback ?? null

  const setValue = (next: JsonValue) => {
    setValues((prev) => ({ ...prev, [active.id]: next }))
  }

  return (
    <main className="studio">
      <header className="masthead">
        <p className="masthead-kicker">@modelschemas/vite · generative UI</p>
        <h1 className="masthead-title">schema studio</h1>
        <p className="masthead-note">
          Every control below is generated at render time from a provider's live
          request schema — pulled into the repo by the vite plugin, pinned in{' '}
          <code>.manifest.json</code>, verified offline on build.
        </p>
      </header>

      <div className="studio-grid">
        <nav className="rail" aria-label="pulled schemas">
          <p className="rail-label">pulled schemas</p>
          {ENTRIES.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={
                entry.id === active.id ? 'rail-card rail-card-on' : 'rail-card'
              }
              onClick={() => setActiveId(entry.id)}
            >
              <span className="rail-provider">{entry.provider}</span>
              <span className="rail-endpoint">{entry.endpoint}</span>
              <span className="rail-kind">#request</span>
            </button>
          ))}
        </nav>

        <section className="canvas" aria-label="generated form">
          <div className="canvas-head">
            <h2 className="canvas-title">
              {active.provider} / {active.endpoint}
            </h2>
            <button
              type="button"
              className="ghost-button"
              onClick={() => setValue(seedValue(active.schema, active.schema))}
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
