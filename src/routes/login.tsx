import { useState } from 'react'
import { createFileRoute, useRouter } from '@tanstack/react-router'

import { SiteFooter, SiteNav } from '#/components/site.tsx'
import { authClient } from '#/lib/auth-client.ts'

export const Route = createFileRoute('/login')({
  component: Login,
})

function Login() {
  const router = useRouter()
  const { data: session, isPending } = authClient.useSession()
  const [email, setEmail] = useState('')
  const [otp, setOtp] = useState('')
  const [step, setStep] = useState<'email' | 'otp'>('email')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const sendCode = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    const { error: sendError } = await authClient.emailOtp.sendVerificationOtp({
      email,
      type: 'sign-in',
    })
    setBusy(false)
    if (sendError) {
      setError(sendError.message ?? 'Could not send the code.')
      return
    }
    setStep('otp')
  }

  const verifyCode = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    const { error: signInError } = await authClient.signIn.emailOtp({
      email,
      otp,
    })
    setBusy(false)
    if (signInError) {
      setError(signInError.message ?? 'Invalid code.')
      return
    }
    await router.invalidate()
  }

  const inputClasses =
    'hairline w-full border bg-paper-raised px-3 py-2 font-mono text-sm text-ink outline-none transition-colors focus:border-ink'
  const buttonClasses =
    'w-full border border-ink bg-ink px-3 py-2 font-mono text-sm text-paper transition-colors hover:bg-press hover:border-press disabled:opacity-50'

  return (
    <div className="min-h-screen text-ink">
      <SiteNav active="sign in" />
      <div className="mx-auto max-w-sm space-y-6 px-5 py-16">
        <header className="space-y-2">
          <h1 className="font-mono text-2xl font-semibold tracking-tight">
            Sign in<span className="text-tok-blue">▌</span>
          </h1>
          <p className="text-sm text-ink-soft">
            Manage your API keys. We email you a one-time code — no password.
          </p>
        </header>

        {isPending ? null : session ? (
          <div className="space-y-3 text-sm">
            <p>
              Signed in as{' '}
              <span className="font-medium">{session.user.email}</span>
            </p>
            <a className="press-link" href="/account">
              Manage API keys →
            </a>
            <button
              type="button"
              className={buttonClasses}
              onClick={() => {
                void authClient.signOut().then(() => router.invalidate())
              }}
            >
              Sign out
            </button>
          </div>
        ) : step === 'email' ? (
          <form
            className="space-y-3"
            onSubmit={(event) => {
              void sendCode(event)
            }}
          >
            <input
              className={inputClasses}
              type="email"
              required
              placeholder="you@example.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            <button className={buttonClasses} disabled={busy} type="submit">
              {busy ? 'Sending…' : 'Email me a code'}
            </button>
          </form>
        ) : (
          <form
            className="space-y-3"
            onSubmit={(event) => {
              void verifyCode(event)
            }}
          >
            <p className="text-sm text-ink-soft">
              Enter the 6-digit code sent to{' '}
              <span className="font-medium">{email}</span>.
            </p>
            <input
              className={`${inputClasses} text-center text-lg tracking-[0.4em]`}
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              placeholder="••••••"
              value={otp}
              onChange={(event) => setOtp(event.target.value)}
            />
            <button className={buttonClasses} disabled={busy} type="submit">
              {busy ? 'Verifying…' : 'Sign in'}
            </button>
            <button
              type="button"
              className="press-link w-full font-mono text-xs text-ink-faint"
              onClick={() => setStep('email')}
            >
              Use a different email
            </button>
          </form>
        )}

        {error ? (
          <p className="font-mono text-sm text-tok-red">{error}</p>
        ) : null}
      </div>
      <SiteFooter />
    </div>
  )
}
