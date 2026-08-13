/**
 * Stability AI — public OpenAPI at api.stability.ai/v2alpha/openapi
 * (legacy path; `info.version` is v2beta). HTML docs at
 * platform.stability.ai/docs/api-reference have no downloadable spec URL.
 * Model catalog is GET /v1/engines/list (Bearer).
 */
import type { Activity } from '#/db/schema.ts'
import { fetchJson, fetchOpenApi, skippedResult } from '../types.ts'
import type {
  ListModelsResult,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

const STABILITY_OPENAPI_URL = 'https://api.stability.ai/v2alpha/openapi'
const STABILITY_ENGINES_URL = 'https://api.stability.ai/v1/engines/list'

const ENGINE_ACTIVITIES: Record<string, Activity> = {
  PICTURE: 'image',
  AUDIO: 'audio',
  VIDEO: 'video',
}

/**
 * Generation is the v2beta image/audio surface (plus leftover v2alpha
 * `/generation/` image POSTs). Result polling, 3D, user/account, and
 * engines/list are platform.
 */
function classify(path: string): Activity | null {
  if (path.includes('/result/') || path.includes('/results/')) return null
  if (path.includes('/stable-image/') || path.includes('/generation/')) {
    return 'image'
  }
  if (path.includes('/audio/')) return 'audio'
  return null
}

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const { spec, hash } = await fetchOpenApi(STABILITY_OPENAPI_URL)
  return {
    specs: [spec],
    sources: [{ url: STABILITY_OPENAPI_URL, hash }],
    outputStrategy: 'post-200',
  }
}

interface StabilityEngine {
  id: string
  name?: string
  type?: string
}

async function listModels(env: ProviderSecrets): Promise<ListModelsResult> {
  const key = env.STABILITY_API_KEY
  if (!key) {
    return { models: [], ...skippedResult('stability', 'STABILITY_API_KEY') }
  }
  const body = (await fetchJson(STABILITY_ENGINES_URL, {
    headers: { Authorization: `Bearer ${key}` },
  })) as Array<StabilityEngine>
  return {
    models: (Array.isArray(body) ? body : [])
      .filter((m) => typeof m.id === 'string' && m.id.length > 0)
      .map((m) => ({
        rawId: m.id,
        displayName: m.name ?? null,
        activity: ENGINE_ACTIVITIES[m.type ?? ''] ?? null,
      })),
  }
}

export const provider: ProviderConfig = {
  id: 'stability',
  displayName: 'Stability AI',
  authEnvVar: 'STABILITY_API_KEY',
  specSourceUrl: STABILITY_OPENAPI_URL,
  modelsEndpoint: STABILITY_ENGINES_URL,
  defaultDerivation: 'upstream-spec',
  fetchSpec,
  listModels,
  classify,
}
