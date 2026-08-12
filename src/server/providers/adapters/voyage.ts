/**
 * Voyage AI — official OpenAPI spec from github.com/voyage-ai/openapi
 * (`voyage-openapi.yml`; the hinted `openapi.yaml` 404s). Embeddings only;
 * rerank is not in our activity enum.
 */
import type { Activity } from '#/db/schema.ts'
import { fetchJson, fetchOpenApi, skippedResult } from '../types.ts'
import type {
  ListModelsResult,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

const VOYAGE_OPENAPI_URL =
  'https://raw.githubusercontent.com/voyage-ai/openapi/main/voyage-openapi.yml'
const VOYAGE_MODELS_URL = 'https://api.voyageai.com/v1/models'

/**
 * Path rules — the published spec (and docs) sit under server
 * `https://api.voyageai.com/v1`, so classify sees `/embeddings` etc. Also
 * accept a `/v1/` prefix. Text, multimodal, and contextualized embedding
 * POSTs are generation; rerank, models, and batch/admin are platform.
 */
function classify(path: string): Activity | null {
  const bare = path.startsWith('/v1/') ? path.slice(3) : path
  if (
    bare === '/embeddings' ||
    bare === '/multimodalembeddings' ||
    bare === '/contextualizedembeddings'
  ) {
    return 'embeddings'
  }
  return null
}

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const { spec, hash } = await fetchOpenApi(VOYAGE_OPENAPI_URL)
  return {
    specs: [spec],
    sources: [{ url: VOYAGE_OPENAPI_URL, hash }],
    outputStrategy: 'post-200',
  }
}

interface VoyageModelList {
  data?: Array<{ id: string; created?: number }>
}

async function listModels(env: ProviderSecrets): Promise<ListModelsResult> {
  const key = env.VOYAGE_API_KEY
  if (!key) {
    return { models: [], ...skippedResult('voyage', 'VOYAGE_API_KEY') }
  }
  const body = (await fetchJson(VOYAGE_MODELS_URL, {
    headers: { Authorization: `Bearer ${key}` },
  })) as VoyageModelList
  return {
    models: (body.data ?? []).map((m) => ({
      rawId: m.id,
      releasedAt: m.created ?? null,
    })),
  }
}

export const provider: ProviderConfig = {
  id: 'voyage',
  displayName: 'Voyage AI',
  authEnvVar: 'VOYAGE_API_KEY',
  specSourceUrl: VOYAGE_OPENAPI_URL,
  modelsEndpoint: VOYAGE_MODELS_URL,
  defaultDerivation: 'upstream-spec',
  fetchSpec,
  listModels,
  classify,
}
