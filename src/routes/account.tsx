import { useEffect, useState } from 'react'
import { createFileRoute, useRouter } from '@tanstack/react-router'

import { SiteFooter, SiteNav } from '#/components/site.tsx'
import { authClient } from '#/lib/auth-client.ts'

export const Route = createFileRoute('/account')({
  component: Account,
})

interface KeyRow {
  id: string
  name: string | null
  start: string | null
  createdAt: string | Date
  expiresAt: string | Date | null
  enabled: boolean
}

const EXPIRY_CHOICES: Array<[label: string, seconds: number | undefined]> = [
  ['Never expires', undefined],
  ['30 days', 30 * 86_400],
  ['90 days', 90 * 86_400],
  ['1 year', 365 * 86_400],
]

function Account() {
  const router = useRouter()
  const { data: session, isPending } = authClient.useSession()
  const [keys, setKeys] = useState<Array<KeyRow>>([])
  const [name, setName] = useState('')
  const [expiry, setExpiry] = useState<string>('')
  const [createdKey, setCreatedKey] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = async () => {
    const { data } = await authClient.apiKey.list()
    const rows = Array.isArray(data)
      ? (data as Array<KeyRow>)
      : ((data as { apiKeys?: Array<KeyRow> } | null)?.apiKeys ?? [])
    setKeys(rows)
  }

  useEffect(() => {
    if (session) void refresh()
  }, [session])

  const createKey = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    const expiresIn = expiry === '' ? undefined : Number(expiry)
    const { data, error: createError } = await authClient.apiKey.create({
      name: name || 'api key',
      ...(expiresIn !== undefined ? { expiresIn } : {}),
    })
    setBusy(false)
    if (createError) {
      setError(createError.message ?? 'Could not create the key.')
      return
    }
    setCreatedKey((data as { key: string }).key)
    setName('')
    await refresh()
  }

  const revokeKey = async (keyId: string) => {
    setError(null)
    const { error: deleteError } = await authClient.apiKey.delete({ keyId })
    if (deleteError) {
      setError(deleteError.message ?? 'Could not revoke the key.')
      return
    }
    await refresh()
  }

  const inputClasses =
    'hairline border bg-paper-raised px-3 py-2 font-mono text-sm text-ink outline-none transition-colors focus:border-ink'

  if (isPending) return null
  if (!session) {
    return (
      <div className="min-h-screen text-ink">
        <SiteNav active="account" />
        <div className="mx-auto max-w-sm space-y-4 px-5 py-16 text-sm">
          <h1 className="font-mono text-2xl font-semibold tracking-tight">
            Account<span className="text-tok-blue">▌</span>
          </h1>
          <p className="text-ink-soft">
            You need to sign in to manage API keys.
          </p>
          <a className="press-link" href="/login">
            Sign in with email →
          </a>
        </div>
        <SiteFooter />
      </div>
    )
  }

  return (
    <div className="min-h-screen text-ink">
      <SiteNav active="account" />
      <div className="mx-auto max-w-2xl space-y-8 px-5 py-14">
        <header className="space-y-2">
          <h1 className="font-mono text-2xl font-semibold tracking-tight">
            Account<span className="text-tok-blue">▌</span>
          </h1>
          <p className="text-sm text-ink-soft">
            Signed in as <span className="font-mono">{session.user.email}</span>{' '}
            ·{' '}
            <button
              type="button"
              className="press-link"
              onClick={() => {
                void authClient.signOut().then(() => router.invalidate())
              }}
            >
              sign out
            </button>
          </p>
        </header>

        <section className="space-y-3">
          <h2 className="overline-label rule-heavy pb-2 !text-ink">API keys</h2>
          <p className="text-sm text-ink-soft">
            Keys unlock 5,000 requests/hour (vs 60/hour anonymous) and webhook
            subscriptions. Send them as{' '}
            <code className="bg-paper-raised px-1 text-press-deep">
              Authorization: Bearer &lt;key&gt;
            </code>
            .
          </p>

          {createdKey ? (
            <div className="figure space-y-2 p-4 text-sm">
              <p className="font-medium">
                Key created — copy it now, it is shown exactly once:
              </p>
              <code className="block break-all bg-paper px-2 py-1 text-press-deep">
                {createdKey}
              </code>
              <pre className="overflow-x-auto bg-paper px-2 py-1 font-mono text-xs text-ink-soft">
                {`curl https://modelschemas.com/v1/agents/me \\\n  -H "Authorization: Bearer ${createdKey}"`}
              </pre>
              <button
                type="button"
                className="press-link font-mono text-xs text-ink-faint"
                onClick={() => setCreatedKey(null)}
              >
                Done, hide it
              </button>
            </div>
          ) : null}

          <form
            className="flex flex-wrap gap-2"
            onSubmit={(event) => {
              void createKey(event)
            }}
          >
            <input
              className={`${inputClasses} flex-1`}
              placeholder="Key name (e.g. my laptop)"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <select
              className={inputClasses}
              value={expiry}
              onChange={(event) => setExpiry(event.target.value)}
            >
              {EXPIRY_CHOICES.map(([label, seconds]) => (
                <option key={label} value={seconds ?? ''}>
                  {label}
                </option>
              ))}
            </select>
            <button
              className="border border-ink bg-ink px-4 py-2 font-mono text-sm text-paper transition-colors hover:border-press hover:bg-press disabled:opacity-50"
              disabled={busy}
              type="submit"
            >
              {busy ? 'Creating…' : 'Create key'}
            </button>
          </form>

          {keys.length === 0 ? (
            <p className="text-sm text-ink-faint">No keys yet.</p>
          ) : (
            <ul className="space-y-2">
              {keys.map((key) => (
                <li
                  key={key.id}
                  className="figure flex items-center gap-3 px-4 py-2.5 text-sm"
                >
                  <span className="flex-1">
                    <span className="font-medium">{key.name ?? 'unnamed'}</span>{' '}
                    <code className="font-mono text-xs text-ink-faint">
                      {key.start ?? '…'}…
                    </code>
                  </span>
                  <span className="font-mono text-xs text-ink-faint">
                    {key.expiresAt
                      ? `expires ${new Date(key.expiresAt).toLocaleDateString()}`
                      : 'no expiry'}
                  </span>
                  <button
                    type="button"
                    className="cursor-pointer font-mono text-xs text-tok-red hover:underline"
                    onClick={() => {
                      void revokeKey(key.id)
                    }}
                  >
                    revoke
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {error ? (
          <p className="font-mono text-sm text-tok-red">{error}</p>
        ) : null}

        <footer className="font-mono text-xs text-ink-faint">
          Agents can self-register instead — see{' '}
          <a className="press-link text-ink-soft" href="/docs">
            the docs
          </a>{' '}
          or{' '}
          <a
            className="press-link text-ink-soft"
            href="/.well-known/agent-configuration"
          >
            agent discovery
          </a>
          .
        </footer>
      </div>
      <SiteFooter />
    </div>
  )
}
