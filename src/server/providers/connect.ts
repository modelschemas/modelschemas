/**
 * Connect-profile helpers + defaults for assembled provider OpenAPI docs.
 */
import type { ProviderConfig, ProviderConnect, SpecGrain } from './types.ts'

/** Refuse assembly above this many endpoints (same number as the model page). */
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
  extra?: Partial<ProviderConnect>,
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

export function resolveSpecGrain(provider: ProviderConfig): SpecGrain {
  return provider.specGrain ?? 'provider'
}

/**
 * Declared connect profile, or a Bearer default derived from
 * `modelsEndpoint` (strip a trailing `/models`) for adapters that have
 * not set one.
 */
export function resolveConnect(provider: ProviderConfig): ProviderConnect {
  if (provider.connect) return provider.connect
  const modelsEndpoint = provider.modelsEndpoint
  if (modelsEndpoint) {
    return bearerConnect(modelsEndpoint.replace(/\/models\/?$/, ''))
  }
  return {
    servers: [],
    securitySchemes: {},
    security: [],
  }
}
