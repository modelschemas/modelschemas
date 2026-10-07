/**
 * Jina AI — public OpenAPI spec at api.jina.ai/openapi.json.
 * Models endpoint requires JINA_API_KEY.
 */
import type { Activity } from '#/db/schema.ts'
import { perTokenListingCard } from '../catalog-prices.ts'
import { jinaChatModel, parseJinaChatRequest } from '../jina-chat.ts'
import { listOpenAiCompatibleModels } from '../openai-compat.ts'
import { compatGenerationEndpointId, jinaModelActivity } from '../model-meta.ts'
import { fetchOpenApi } from '../types.ts'
import type {
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

const JINA_OPENAPI_URL = 'https://api.jina.ai/openapi.json'
const JINA_MODELS_URL = 'https://api.jina.ai/v1/models'

/**
 * Embeddings and chat completions. Rerank, classifier, train, and the
 * rest of the Search Foundation API classify to null.
 */
function classify(path: string): Activity | null {
  const bare = (path.split('?')[0] ?? path).replace(/\/+$/, '')
  if (bare.endsWith('/embeddings')) return 'embeddings'
  if (bare.endsWith('/chat/completions')) return 'chat'
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
  listModels: async (env) => {
    if (!env.JINA_API_KEY) {
      return listOpenAiCompatibleModels({
        providerId: 'jina',
        url: JINA_MODELS_URL,
        env,
        envVar: 'JINA_API_KEY',
      })
    }
    // Chat ids and the request map come from the same document fetchSpec
    // stores. A spec that names no chat model throws, so a poll does not
    // unclassify every text row.
    const { spec } = await fetchOpenApi(JINA_OPENAPI_URL)
    const chat = parseJinaChatRequest(spec)
    return listOpenAiCompatibleModels({
      providerId: 'jina',
      url: JINA_MODELS_URL,
      env,
      envVar: 'JINA_API_KEY',
      activity: (row) => jinaModelActivity(row, chat.modelIds),
      extend: async (row) => {
        const pricing = await perTokenListingCard(row.pricing, JINA_MODELS_URL)
        const requestMap = jinaChatModel(row.id, chat.modelIds)
          ? chat.requestMap
          : null
        return {
          ...(pricing ? { pricing } : {}),
          ...(requestMap ? { requestMap } : {}),
        }
      },
    })
  },
  classify,
  generationEndpointId: ({ activity }) =>
    compatGenerationEndpointId(activity, 'v1/'),
}
