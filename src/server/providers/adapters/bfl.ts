/**
 * Black Forest Labs — first-party OpenAPI 3.1 spec at api.bfl.ai/openapi.json
 * (public). Generation is POST /v1/flux-* (image) and /v1/flux-3-video.
 * Utility, finetune admin, credits, and result polling classify null.
 * The spec has no /models path; listModels tries the hinted URL then falls
 * back to path-derived ids. Auth header is `x-key`.
 */
import type { Activity } from '#/db/schema.ts'
import { fetchJson, fetchOpenApi, skippedResult } from '../types.ts'
import type {
  ListModelsResult,
  ModelInfo,
  OpenApiOperation,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

const BFL_OPENAPI_URL = 'https://api.bfl.ai/openapi.json'
const BFL_MODELS_URL = 'https://api.bfl.ai/v1/models'

/** Model ids derived from generation paths when GET /v1/models is absent. */
const CURATED_MODELS: Array<ModelInfo> = [
  { rawId: 'flux-2-pro', activity: 'image' },
  { rawId: 'flux-2-pro-preview', activity: 'image' },
  { rawId: 'flux-2-max', activity: 'image' },
  { rawId: 'flux-2-flex', activity: 'image' },
  { rawId: 'flux-2-klein-9b', activity: 'image' },
  { rawId: 'flux-2-klein-9b-preview', activity: 'image' },
  { rawId: 'flux-2-klein-4b', activity: 'image' },
  { rawId: 'flux-pro-1.1', activity: 'image' },
  { rawId: 'flux-pro-1.1-ultra', activity: 'image' },
  { rawId: 'flux-dev', activity: 'image' },
  { rawId: 'flux-pro-1.0-fill', activity: 'image' },
  { rawId: 'flux-pro-1.0-expand', activity: 'image' },
  { rawId: 'flux-kontext-pro', activity: 'image' },
  { rawId: 'flux-kontext-max', activity: 'image' },
  { rawId: 'flux-3-video', activity: 'video' },
]

const PLATFORM_PATHS = new Set([
  '/v1/credits',
  '/v1/get_result',
  '/v1/delete_finetune',
  '/v1/finetune_details',
  '/v1/my_finetunes',
])

function classify(path: string, op: OpenApiOperation): Activity | null {
  const tags = Array.isArray(op.tags) ? (op.tags as Array<string>) : []
  if (tags.includes('Utility') || PLATFORM_PATHS.has(path)) return null
  if (path.includes('video')) return 'video'
  if (tags.includes('Models') || path.startsWith('/v1/flux')) return 'image'
  return null
}

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const { spec, hash } = await fetchOpenApi(BFL_OPENAPI_URL)
  return {
    specs: [spec],
    sources: [{ url: BFL_OPENAPI_URL, hash }],
    outputStrategy: 'post-200',
  }
}

interface BflModelRow {
  id?: string
  created?: number
}

function rowsFromModelsBody(body: unknown): Array<BflModelRow> {
  if (Array.isArray(body)) return body as Array<BflModelRow>
  if (body !== null && typeof body === 'object') {
    const record = body as { data?: unknown; models?: unknown }
    if (Array.isArray(record.data)) return record.data as Array<BflModelRow>
    if (Array.isArray(record.models)) return record.models as Array<BflModelRow>
  }
  return []
}

async function listModels(env: ProviderSecrets): Promise<ListModelsResult> {
  const key = env.BFL_API_KEY
  if (!key) {
    return { models: [], ...skippedResult('bfl', 'BFL_API_KEY') }
  }
  try {
    const body = await fetchJson(BFL_MODELS_URL, {
      headers: { 'x-key': key },
    })
    const models = rowsFromModelsBody(body)
      .filter((m) => typeof m.id === 'string' && m.id.length > 0)
      .map((m) => ({
        rawId: m.id as string,
        releasedAt: m.created ?? null,
      }))
    if (models.length > 0) return { models }
  } catch {
    // Hinted /v1/models is not in the published spec — use the path catalog.
  }
  return { models: CURATED_MODELS }
}

export const provider: ProviderConfig = {
  id: 'bfl',
  displayName: 'Black Forest Labs',
  authEnvVar: 'BFL_API_KEY',
  specSourceUrl: BFL_OPENAPI_URL,
  modelsEndpoint: BFL_MODELS_URL,
  defaultDerivation: 'upstream-spec',
  fetchSpec,
  listModels,
  classify,
}
