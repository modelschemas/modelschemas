/**
 * Server-side sweep of every provider's video activity schemas, plus a
 * validation proxy — the modelschemas API is only ever called from the
 * server, so the browser needs no CORS.
 */
import { createServerFn } from '@tanstack/react-start'
import {
  createModelschemasClient,
  getActivitySchemas,
  listProviders,
  validatePayload,
} from '@modelschemas/client'
import { extractVideoControls } from '../lib/video'
import type { SchemaNode, VideoControls } from '../lib/video'

const BASE_URL = process.env.MODELSCHEMAS_URL ?? 'https://modelschemas.com'

export interface VideoModelEntry {
  provider: string
  endpointId: string
  controls: VideoControls
}

export interface VideoCatalog {
  baseUrl: string
  providers: Array<string>
  entries: Array<VideoModelEntry>
}

function isNode(value: unknown): value is SchemaNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function makeClient() {
  return createModelschemasClient({ baseUrl: BASE_URL })
}

async function buildCatalog(): Promise<VideoCatalog> {
  const client = makeClient()

  const providersResult = await listProviders({ client })
  const providerList = isNode(providersResult.data)
    ? providersResult.data['providers']
    : undefined
  const providerIds = Array.isArray(providerList)
    ? providerList
        .map((entry) => (isNode(entry) ? entry['id'] : undefined))
        .filter((id): id is string => typeof id === 'string')
    : []

  const entries: Array<VideoModelEntry> = []
  await Promise.all(
    providerIds.map(async (provider) => {
      const result = await getActivitySchemas({
        client,
        path: { provider, activity: 'video' },
      })
      if (result.error !== undefined || !isNode(result.data)) return
      const endpoints = result.data['endpoints']
      if (!isNode(endpoints)) return
      for (const [endpointId, pair] of Object.entries(endpoints)) {
        if (!isNode(pair)) continue
        const input = pair['input']
        if (!isNode(input)) continue
        const controls = extractVideoControls(input)
        // Only list endpoints that are actually composable: a prompt plus
        // at least one schema-constrained knob.
        if (
          controls.promptPath !== null &&
          (controls.aspect !== null || controls.duration !== null)
        ) {
          entries.push({ provider, endpointId, controls })
        }
      }
    }),
  )

  entries.sort((a, b) =>
    a.provider === b.provider
      ? a.endpointId.localeCompare(b.endpointId)
      : a.provider.localeCompare(b.provider),
  )
  return { baseUrl: BASE_URL, providers: providerIds, entries }
}

let cache: { at: number; catalog: Promise<VideoCatalog> } | null = null
const TTL_MS = 5 * 60 * 1000

export const getVideoCatalog = createServerFn({ method: 'GET' }).handler(
  (): Promise<VideoCatalog> => {
    if (cache === null || Date.now() - cache.at > TTL_MS) {
      cache = { at: Date.now(), catalog: buildCatalog() }
      cache.catalog.catch(() => {
        cache = null
      })
    }
    return cache.catalog
  },
)

export interface ValidationOutcome {
  valid: boolean
  errors: Array<{ path: string; message: string }>
  failure: string | null
}

interface ValidateInput {
  provider: string
  endpointId: string
  payload: unknown
}

function narrowValidateInput(input: unknown): ValidateInput {
  if (!isNode(input)) throw new Error('expected an object')
  const provider = input['provider']
  const endpointId = input['endpointId']
  if (typeof provider !== 'string' || typeof endpointId !== 'string') {
    throw new Error('provider and endpointId must be strings')
  }
  return { provider, endpointId, payload: input['payload'] }
}

export const validateVideoRequest = createServerFn({ method: 'POST' })
  .inputValidator(narrowValidateInput)
  .handler(async ({ data }): Promise<ValidationOutcome> => {
    const client = makeClient()
    const result = await validatePayload({
      client,
      body: {
        provider: data.provider,
        endpointId: data.endpointId,
        kind: 'input',
        payload: data.payload,
      },
    })
    if (result.error !== undefined || !isNode(result.data)) {
      return {
        valid: false,
        errors: [],
        failure: `validation call failed (${String(result.response?.status ?? 'no response')})`,
      }
    }
    const errors: Array<{ path: string; message: string }> = []
    const rawErrors = result.data['errors']
    if (Array.isArray(rawErrors)) {
      for (const entry of rawErrors) {
        if (!isNode(entry)) continue
        const path = entry['path']
        const message = entry['message']
        errors.push({
          path: typeof path === 'string' ? path : '',
          message: typeof message === 'string' ? message : 'invalid',
        })
      }
    }
    return { valid: result.data['valid'] === true, errors, failure: null }
  })
