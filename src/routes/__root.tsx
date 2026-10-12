import { HeadContent, Scripts, createRootRoute } from '@tanstack/react-router'
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools'
import { TanStackDevtools } from '@tanstack/react-devtools'
import { PostHogProvider } from '@posthog/react'

import { PostHogIdentity } from '#/components/posthog-identity.tsx'
import appCss from '../styles.css?url'

const posthogToken = import.meta.env.VITE_PUBLIC_POSTHOG_PROJECT_TOKEN
const posthogHost = import.meta.env.VITE_PUBLIC_POSTHOG_HOST

export const Route = createRootRoute({
  head: () => ({
    meta: [
      {
        charSet: 'utf-8',
      },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1',
      },
      {
        title: 'modelschemas — live AI model schemas',
      },
      {
        name: 'description',
        content:
          'Which AI models exist right now, and what do their payloads look like? Live request/response JSON Schemas and model metadata across OpenAI, Anthropic, Gemini, Grok, ElevenLabs, OpenRouter, FAL and BytePlus — built for agents.',
      },
    ],
    links: [
      {
        rel: 'stylesheet',
        href: appCss,
      },
      {
        rel: 'icon',
        type: 'image/svg+xml',
        href: '/icon.svg',
      },
    ],
  }),
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  if ((!posthogToken || !posthogHost) && import.meta.env.DEV) {
    const missing = !posthogToken
      ? 'VITE_PUBLIC_POSTHOG_PROJECT_TOKEN'
      : 'VITE_PUBLIC_POSTHOG_HOST'
    throw new Error(
      `${missing} variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once ${missing} is configured`,
    )
  }

  const content = (
    <>
      {children}
      <TanStackDevtools
        config={{
          position: 'bottom-right',
        }}
        plugins={[
          {
            name: 'Tanstack Router',
            render: <TanStackRouterDevtoolsPanel />,
          },
        ]}
      />
    </>
  )

  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {posthogToken && posthogHost ? (
          <PostHogProvider
            apiKey={posthogToken}
            options={{
              api_host: posthogHost,
              ui_host: posthogHost,
              defaults: '2025-05-24',
              capture_exceptions: true,
              debug: import.meta.env.DEV,
              logs: {
                environment: import.meta.env.MODE,
                serviceName: 'modelschemas-web',
              },
              tracing_headers:
                typeof window !== 'undefined' ? [window.location.hostname] : [],
            }}
          >
            <PostHogIdentity />
            {content}
          </PostHogProvider>
        ) : (
          content
        )}
        <Scripts />
      </body>
    </html>
  )
}
