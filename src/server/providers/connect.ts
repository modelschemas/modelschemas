/**
 * Connect-profile helpers + defaults for assembled provider OpenAPI docs.
 */
import type { ProviderConfig, ProviderConnect, SpecGrain } from './types.ts'

/** Refuse assembly above this many classified generation endpoints. */
export const MAX_SPEC_PATHS = 40

export function bearerConnect(
  serverUrl: string,
  description?: string,
): ProviderConnect {
  return {
    servers: [{ url: serverUrl, ...(description ? { description } : {}) }],
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        description: 'Provider API key as `Authorization: Bearer <key>`.',
      },
    },
    security: [{ bearerAuth: [] }],
  }
}

export function headerApiKeyConnect(
  serverUrl: string,
  headerName: string,
  extra?: Pick<ProviderConnect, 'requiredHeaders' | 'siblingGet'>,
): ProviderConnect {
  return {
    servers: [{ url: serverUrl }],
    securitySchemes: {
      apiKey: {
        type: 'apiKey',
        in: 'header',
        name: headerName,
      },
    },
    security: [{ apiKey: [] }],
    ...extra,
  }
}

export function resolveSpecGrain(
  provider: ProviderConfig | undefined,
): SpecGrain {
  return provider?.specGrain ?? 'provider'
}

/**
 * Declared connect profile only. Adapters without `connect` are not
 * guessed from `modelsEndpoint` (that URL is often not the data plane).
 */
export function resolveConnect(
  provider: ProviderConfig | undefined,
): ProviderConnect | null {
  return provider?.connect ?? null
}
