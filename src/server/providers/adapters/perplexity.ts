/**
 * Perplexity — public OpenAPI 3.1 spec at docs.perplexity.ai/openapi.json.
 * Generation is Sonar (`/v1/sonar`) and the Agent API (`/v1/agent`), plus
 * embeddings. Search, async jobs, files/cancel, and analytics are platform.
 */
import type { Activity } from '#/db/schema.ts'
import { perplexityListingCard } from '../catalog-prices.ts'
import { perplexityGenerationEndpointId } from '../model-meta.ts'
import { fetchJson, fetchOpenApi, skippedResult } from '../types.ts'
import type {
  ListModelsResult,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

const PERPLEXITY_OPENAPI_URL = 'https://docs.perplexity.ai/openapi.json'
const PERPLEXITY_MODELS_URL = 'https://api.perplexity.ai/v1/models'

function classify(path: string): Activity | null {
  if (path === '/v1/sonar' || path === '/v1/agent') return 'chat'
  if (path === '/v1/embeddings' || path === '/v1/contextualizedembeddings') {
    return 'embeddings'
  }
  return null
}

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const { spec, hash } = await fetchOpenApi(PERPLEXITY_OPENAPI_URL)
  return {
    specs: [spec],
    sources: [{ url: PERPLEXITY_OPENAPI_URL, hash }],
    outputStrategy: 'post-200',
  }
}

interface PerplexityModelList {
  data?: Array<{ id: string; created?: number; pricing?: unknown }>
}

async function listModels(env: ProviderSecrets): Promise<ListModelsResult> {
  const key = env.PERPLEXITY_API_KEY
  if (!key) {
    return { models: [], ...skippedResult('perplexity', 'PERPLEXITY_API_KEY') }
  }
  const body = (await fetchJson(PERPLEXITY_MODELS_URL, {
    headers: { Authorization: `Bearer ${key}` },
  })) as PerplexityModelList
  const models = []
  for (const m of body.data ?? []) {
    const pricing = await perplexityListingCard(
      m.pricing,
      PERPLEXITY_MODELS_URL,
    )
    models.push({
      rawId: m.id,
      releasedAt: m.created ?? null,
      activity: 'chat' as const,
      ...(pricing ? { pricing } : {}),
    })
  }
  return { models }
}

export const provider: ProviderConfig = {
  id: 'perplexity',
  displayName: 'Perplexity',
  authEnvVar: 'PERPLEXITY_API_KEY',
  specSourceUrl: PERPLEXITY_OPENAPI_URL,
  modelsEndpoint: PERPLEXITY_MODELS_URL,
  defaultDerivation: 'upstream-spec',
  fetchSpec,
  listModels,
  classify,
  generationEndpointId: ({ rawId }) => perplexityGenerationEndpointId(rawId),
}
