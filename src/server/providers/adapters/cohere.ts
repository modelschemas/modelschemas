/**
 * Cohere — official OpenAPI YAML from cohere-ai/cohere-developer-experience
 * (public). Models list requires COHERE_API_KEY.
 */
import type { Activity } from '#/db/schema.ts'
import { fetchJson, fetchOpenApi, skippedResult } from '../types.ts'
import type {
  ListModelsResult,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

const COHERE_OPENAPI_URL =
  'https://raw.githubusercontent.com/cohere-ai/cohere-developer-experience/main/cohere-openapi.yaml'
const COHERE_MODELS_URL = 'https://api.cohere.com/v1/models'

/**
 * Chat (v1/v2 + legacy generate/summarize) and embed. Audio transcriptions
 * are generation; rerank/classify/datasets/finetune/batches/admin drop.
 */
function classify(path: string): Activity | null {
  const bare = path.split('?')[0] ?? path
  if (
    bare === '/v1/chat' ||
    bare === '/v2/chat' ||
    bare === '/chat' ||
    bare === '/v1/generate' ||
    bare === '/v1/summarize'
  ) {
    return 'chat'
  }
  if (bare === '/v1/embed' || bare === '/v2/embed') return 'embeddings'
  if (bare === '/v2/audio/transcriptions') return 'audio'
  return null
}

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const { spec, hash } = await fetchOpenApi(COHERE_OPENAPI_URL)
  return {
    specs: [spec],
    sources: [{ url: COHERE_OPENAPI_URL, hash }],
    outputStrategy: 'post-200',
  }
}

interface CohereModel {
  name?: string
  is_deprecated?: boolean
  endpoints?: Array<string>
  context_length?: number
}

interface CohereModelList {
  models?: Array<CohereModel>
  next_page_token?: string
}

function activityFromEndpoints(
  endpoints: Array<string> | undefined,
): Activity | null {
  if (!endpoints?.length) return null
  if (
    endpoints.includes('chat') ||
    endpoints.includes('generate') ||
    endpoints.includes('summarize')
  ) {
    return 'chat'
  }
  if (endpoints.includes('embed')) return 'embeddings'
  return null
}

async function listModels(env: ProviderSecrets): Promise<ListModelsResult> {
  const key = env.COHERE_API_KEY
  if (!key) {
    return { models: [], ...skippedResult('cohere', 'COHERE_API_KEY') }
  }
  const models: ListModelsResult['models'] = []
  let pageToken: string | undefined
  do {
    const url = new URL(COHERE_MODELS_URL)
    url.searchParams.set('page_size', '1000')
    if (pageToken) url.searchParams.set('page_token', pageToken)
    const body = (await fetchJson(url.toString(), {
      headers: { Authorization: `Bearer ${key}` },
    })) as CohereModelList
    for (const m of body.models ?? []) {
      if (typeof m.name !== 'string' || m.name.length === 0) continue
      models.push({
        rawId: m.name,
        contextWindow: m.context_length ?? null,
        activity: activityFromEndpoints(m.endpoints),
        deprecated: m.is_deprecated ?? false,
      })
    }
    const next = body.next_page_token
    pageToken = next && next !== pageToken ? next : undefined
  } while (pageToken)
  return { models }
}

export const provider: ProviderConfig = {
  id: 'cohere',
  displayName: 'Cohere',
  authEnvVar: 'COHERE_API_KEY',
  specSourceUrl: COHERE_OPENAPI_URL,
  modelsEndpoint: COHERE_MODELS_URL,
  defaultDerivation: 'upstream-spec',
  fetchSpec,
  listModels,
  classify,
}
