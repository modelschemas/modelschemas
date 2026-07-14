/**
 * Browser-side catalog: in production the app is served from
 * modelschemas.com/examples/…, so API calls are same-origin; `vite dev`
 * proxies /v1 to MODELSCHEMAS_URL (see vite.config.ts). Either way the
 * browser needs no CORS.
 */
import { createIsomorphicFn } from '@tanstack/react-start'
import {
  createModelschemasClient,
  getActivitySchemas,
  listProviders,
} from '@modelschemas/client'
import { extractDimensions } from './dimensions'
import type { DimensionReport, SchemaNode } from './dimensions'

// Each branch is compiled out of the other bundle, so the client never
// references process.env and the server never touches window.
const getBaseUrl = createIsomorphicFn()
  .server(() => process.env.MODELSCHEMAS_URL ?? 'https://modelschemas.com')
  .client(() => window.location.origin)

export interface ImageModelEntry {
  provider: string
  endpointId: string
  report: DimensionReport
}

export interface ImageCatalog {
  baseUrl: string
  /** Providers swept, in catalog order. */
  providers: Array<string>
  entries: Array<ImageModelEntry>
}

function isNode(value: unknown): value is SchemaNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function buildCatalog(): Promise<ImageCatalog> {
  const baseUrl = getBaseUrl()
  const client = createModelschemasClient({ baseUrl })

  const providersResult = await listProviders({ client })
  const providerList = isNode(providersResult.data)
    ? providersResult.data['providers']
    : undefined
  const providerIds = Array.isArray(providerList)
    ? providerList
        .map((entry) => (isNode(entry) ? entry['id'] : undefined))
        .filter((id): id is string => typeof id === 'string')
    : []

  const entries: Array<ImageModelEntry> = []
  await Promise.all(
    providerIds.map(async (provider) => {
      // 404 = provider has no image schemas synced; skip quietly.
      const result = await getActivitySchemas({
        client,
        path: { provider, activity: 'image' },
      })
      if (result.error !== undefined || !isNode(result.data)) return
      const endpoints = result.data['endpoints']
      if (!isNode(endpoints)) return
      for (const [endpointId, pair] of Object.entries(endpoints)) {
        if (!isNode(pair)) continue
        const input = pair['input']
        if (!isNode(input)) continue
        entries.push({
          provider,
          endpointId,
          report: extractDimensions(input),
        })
      }
    }),
  )

  entries.sort((a, b) =>
    a.provider === b.provider
      ? a.endpointId.localeCompare(b.endpointId)
      : a.provider.localeCompare(b.provider),
  )
  return { baseUrl, providers: providerIds, entries }
}

let cache: { at: number; catalog: Promise<ImageCatalog> } | null = null
const TTL_MS = 5 * 60 * 1000

export function getImageCatalog(): Promise<ImageCatalog> {
  if (cache === null || Date.now() - cache.at > TTL_MS) {
    cache = { at: Date.now(), catalog: buildCatalog() }
    cache.catalog.catch(() => {
      cache = null
    })
  }
  return cache.catalog
}
