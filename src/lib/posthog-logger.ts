import type { PostHog } from 'posthog-js'

export const posthogIntegrationLogger = {
  info(
    posthog: PostHog,
    body: string,
    attributes: Record<string, boolean | number | string>,
  ): void {
    posthog.logger.info(body, attributes)
  },
}
