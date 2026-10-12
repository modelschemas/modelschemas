import { useEffect } from 'react'
import { usePostHog } from '@posthog/react'

import { authClient } from '#/lib/auth-client.ts'

export function PostHogIdentity() {
  const posthog = usePostHog()
  const { data: session } = authClient.useSession()

  useEffect(() => {
    if (!session?.user.id) return
    posthog.identify(session.user.id, {
      email: session.user.email,
      name: session.user.name,
    })
  }, [posthog, session?.user.email, session?.user.id, session?.user.name])

  return null
}
