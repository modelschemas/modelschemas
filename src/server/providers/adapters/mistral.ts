/**
 * Mistral — public OpenAPI 3.1 at docs.mistral.ai/openapi.yaml.
 * Models listing requires MISTRAL_API_KEY.
 */
import type { Activity } from '#/db/schema.ts'
import { listOpenAiCompatibleModels } from '../openai-compat.ts'
import {
  mistralGenerationEndpointId,
  mistralModelActivity,
} from '../model-meta.ts'
import { mistralModelPricing } from '../mistral-pricing.ts'
import { fetchOpenApi } from '../types.ts'
import type {
  ListModelsResult,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

const MISTRAL_OPENAPI_URL = 'https://docs.mistral.ai/openapi.yaml'
const MISTRAL_MODELS_URL = 'https://api.mistral.ai/v1/models'

/**
 * Generation surface only. Chat/fim/agents-completions are chat;
 * classifiers that are not moderation, OCR, conversations CRUD, files,
 * fine-tune, batch, and admin classify to null.
 */
function classify(path: string): Activity | null {
  const bare = path.includes('#') ? path.slice(0, path.indexOf('#')) : path
  if (
    bare === '/v1/chat/completions' ||
    bare === '/v1/fim/completions' ||
    bare === '/v1/agents/completions'
  ) {
    return 'chat'
  }
  if (bare === '/v1/embeddings') return 'embeddings'
  if (bare === '/v1/moderations' || bare === '/v1/chat/moderations') {
    return 'moderation'
  }
  if (bare === '/v1/audio/speech' || bare === '/v1/audio/transcriptions') {
    return 'audio'
  }
  return null
}

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const { spec, hash } = await fetchOpenApi(MISTRAL_OPENAPI_URL)
  return {
    specs: [spec],
    sources: [{ url: MISTRAL_OPENAPI_URL, hash }],
    outputStrategy: 'post-200',
  }
}

export const provider: ProviderConfig = {
  id: 'mistral',
  displayName: 'Mistral',
  authEnvVar: 'MISTRAL_API_KEY',
  specSourceUrl: MISTRAL_OPENAPI_URL,
  modelsEndpoint: MISTRAL_MODELS_URL,
  defaultDerivation: 'upstream-spec',
  fetchSpec,
  listModels: async (env, kv): Promise<ListModelsResult> => {
    const listed = await listOpenAiCompatibleModels({
      providerId: 'mistral',
      url: MISTRAL_MODELS_URL,
      env,
      envVar: 'MISTRAL_API_KEY',
      activity: mistralModelActivity,
    })
    if (listed.models.length === 0) return listed
    const pricing = await mistralModelPricing(kv)
    return {
      ...listed,
      models: listed.models.map((model) => ({
        ...model,
        ...pricing(model.rawId),
      })),
    }
  },
  classify,
  generationEndpointId: ({ rawId, activity }) =>
    mistralGenerationEndpointId(rawId, activity),
}
