/**
 * Jina AI — public OpenAPI spec at api.jina.ai/openapi.json.
 * Models endpoint requires JINA_API_KEY.
 */
import type { Activity } from '#/db/schema.ts'
import { listOpenAiCompatibleModels } from '../openai-compat.ts'
import { fetchOpenApi } from '../types.ts'
import type {
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

const JINA_OPENAPI_URL = 'https://api.jina.ai/openapi.json'
const JINA_MODELS_URL = 'https://api.jina.ai/v1/models'

/**
 * Generation surface is embeddings only. Rerank, classifier, reader,
 * train, and the rest of the Search Foundation API classify to null.
 */
function classify(path: string): Activity | null {
  const bare = (path.split('?')[0] ?? path).replace(/\/+$/, '')
  if (bare.endsWith('/embeddings')) return 'embeddings'
  return null
}

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const { spec, hash } = await fetchOpenApi(JINA_OPENAPI_URL)
  return {
    specs: [spec],
    sources: [{ url: JINA_OPENAPI_URL, hash }],
    outputStrategy: 'post-200',
  }
}

export const provider: ProviderConfig = {
  id: 'jina',
  displayName: 'Jina AI',
  authEnvVar: 'JINA_API_KEY',
  specSourceUrl: JINA_OPENAPI_URL,
  modelsEndpoint: JINA_MODELS_URL,
  defaultDerivation: 'upstream-spec',
  fetchSpec,
  listModels: (env) =>
    listOpenAiCompatibleModels({
      providerId: 'jina',
      url: JINA_MODELS_URL,
      env,
      envVar: 'JINA_API_KEY',
    }),
  classify,
}
