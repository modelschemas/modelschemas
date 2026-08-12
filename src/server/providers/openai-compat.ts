/**
 * Helpers for OpenAI-compatible providers that do not publish their own
 * spec. fetchSpec pulls the canonical OpenAI document, keeps only the
 * requested generation paths, and rewrites `servers` to the provider host.
 *
 * Derivation is `generated`: the schemas come from OpenAI's spec, not a
 * document the provider itself publishes.
 */
import type { Activity } from '#/db/schema.ts'
import { fetchJson, fetchOpenApi, skippedResult } from './types.ts'
import type {
  ListModelsResult,
  OpenApiDocument,
  ProviderSecrets,
} from './types.ts'

export const OPENAI_OPENAPI_URL =
  'https://raw.githubusercontent.com/openai/openai-openapi/master/openapi.yaml'

export const OPENAI_COMPAT_PATHS = [
  '/chat/completions',
  '/completions',
  '/responses',
  '/embeddings',
  '/audio/speech',
  '/audio/transcriptions',
  '/audio/translations',
  '/images/generations',
  '/images/edits',
  '/images/variations',
  '/videos',
  '/moderations',
] as const

export type OpenAiCompatPath = (typeof OPENAI_COMPAT_PATHS)[number]

const PATH_ACTIVITIES: Record<OpenAiCompatPath, Activity> = {
  '/chat/completions': 'chat',
  '/completions': 'chat',
  '/responses': 'chat',
  '/embeddings': 'embeddings',
  '/audio/speech': 'audio',
  '/audio/transcriptions': 'audio',
  '/audio/translations': 'audio',
  '/images/generations': 'image',
  '/images/edits': 'image',
  '/images/variations': 'image',
  '/videos': 'video',
  '/moderations': 'moderation',
}

export interface OpenAiCompatSpecOptions {
  title: string
  /** Origin + version prefix the provider actually serves, e.g. https://api.groq.com/openai/v1 */
  serverUrl: string
  include: ReadonlyArray<OpenAiCompatPath>
}

export function classifyOpenAiCompat(path: string): Activity | null {
  const bare = path.startsWith('/v1/') ? path.slice(3) : path
  if (bare in PATH_ACTIVITIES) {
    return PATH_ACTIVITIES[bare as OpenAiCompatPath]
  }
  return null
}

export function filterOpenAiSpec(
  spec: OpenApiDocument,
  opts: OpenAiCompatSpecOptions,
): OpenApiDocument {
  const paths: NonNullable<OpenApiDocument['paths']> = {}
  for (const path of opts.include) {
    const operations = spec.paths?.[path]
    if (operations) paths[path] = operations
  }
  return {
    ...spec,
    info: { ...(spec.info ?? {}), title: opts.title },
    servers: [{ url: opts.serverUrl }],
    paths,
  }
}

export async function fetchOpenAiCompatibleSpec(
  opts: OpenAiCompatSpecOptions,
): Promise<{
  spec: OpenApiDocument
  url: string
  hash: string
}> {
  const { spec, hash } = await fetchOpenApi(OPENAI_OPENAPI_URL)
  return {
    spec: filterOpenAiSpec(spec, opts),
    url: OPENAI_OPENAPI_URL,
    hash,
  }
}

interface OpenAiModelList {
  data?: Array<{
    id: string
    created?: number
    owned_by?: string
    object?: string
  }>
}

export async function listOpenAiCompatibleModels(opts: {
  providerId: string
  url: string
  env: ProviderSecrets
  envVar: keyof ProviderSecrets
  /**
   * Extra headers (e.g. Deepgram Token, Cartesia-Version). Authorization
   * is filled in as Bearer unless `authorization` is set.
   */
  headers?: Record<string, string>
  authorization?: string
}): Promise<ListModelsResult> {
  const key = opts.env[opts.envVar]
  if (!key) {
    return { models: [], ...skippedResult(opts.providerId, opts.envVar) }
  }
  const headers: Record<string, string> = {
    Authorization: opts.authorization ?? `Bearer ${key}`,
    ...opts.headers,
  }
  const body = (await fetchJson(opts.url, { headers })) as OpenAiModelList
  return {
    models: (body.data ?? [])
      .filter((m) => typeof m.id === 'string' && m.id.length > 0)
      .map((m) => ({
        rawId: m.id,
        releasedAt: m.created ?? null,
      })),
  }
}
