import { PostHog } from 'posthog-node'

let posthogClient: PostHog | null = null

function configuration(): { host: string; token: string } | null {
  const token = import.meta.env.VITE_PUBLIC_POSTHOG_PROJECT_TOKEN
  const host = import.meta.env.VITE_PUBLIC_POSTHOG_HOST

  if (!token || !host) {
    if (import.meta.env.DEV) {
      const missing = !token
        ? 'VITE_PUBLIC_POSTHOG_PROJECT_TOKEN'
        : 'VITE_PUBLIC_POSTHOG_HOST'
      throw new Error(
        `${missing} variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once ${missing} is configured`,
      )
    }
    return null
  }

  return { host, token }
}

export function getPostHogServerClient(): PostHog | null {
  const config = configuration()
  if (!config) return null

  posthogClient ??= new PostHog(config.token, {
    host: config.host,
    flushAt: 1,
    flushInterval: 0,
    enableExceptionAutocapture: true,
  })
  return posthogClient
}

export function posthogRequestContext(request: Request): {
  distinctId: string
  sessionId?: string
} {
  const distinctId =
    request.headers.get('X-PostHog-Distinct-Id') ?? `api:${crypto.randomUUID()}`
  const sessionId = request.headers.get('X-PostHog-Session-Id') ?? undefined
  return { distinctId, sessionId }
}

export async function captureServerEvent({
  distinctId,
  event,
  properties,
  request,
}: {
  distinctId?: string
  event: string
  properties?: Record<string, unknown>
  request: Request
}): Promise<void> {
  const posthog = getPostHogServerClient()
  if (!posthog) return

  const context = posthogRequestContext(request)
  try {
    posthog.capture({
      distinctId: distinctId ?? context.distinctId,
      event,
      properties: {
        ...properties,
        $session_id: context.sessionId,
        source: 'api',
      },
    })
    await posthog.flush()
  } catch (error) {
    console.error('PostHog event capture failed', event, error)
  }
}
