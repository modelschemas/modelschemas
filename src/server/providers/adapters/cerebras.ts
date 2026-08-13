/**
 * Cerebras Inference — first-party OpenAPI 3.1 spec at
 * inference-docs.cerebras.ai/api-reference/openapi.yaml (public). The hinted
 * chat-completions docs page is HTML; this is the machine-readable document
 * published next to it. Models list requires CEREBRAS_API_KEY.
 */
import type { Activity } from '#/db/schema.ts'
import { listOpenAiCompatibleModels } from '../openai-compat.ts'
import { fetchOpenApi } from '../types.ts'
import type {
  ListModelsResult,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

const CEREBRAS_OPENAPI_URL =
  'https://inference-docs.cerebras.ai/api-reference/openapi.yaml'
const CEREBRAS_MODELS_URL = 'https://api.cerebras.ai/v1/models'

/**
 * Cerebras is OpenAI-compatible chat. Completions is the same activity;
 * models, files, batches, and dedicated-endpoint admin classify null.
 */
function classify(path: string): Activity | null {
  const bare = path.startsWith('/v1/') ? path.slice(3) : path
  if (bare === '/chat/completions' || bare === '/completions') return 'chat'
  return null
}

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const { spec, hash } = await fetchOpenApi(CEREBRAS_OPENAPI_URL)
  return {
    specs: [spec],
    sources: [{ url: CEREBRAS_OPENAPI_URL, hash }],
    outputStrategy: 'post-200',
  }
}

async function listModels(env: ProviderSecrets): Promise<ListModelsResult> {
  return listOpenAiCompatibleModels({
    providerId: 'cerebras',
    url: CEREBRAS_MODELS_URL,
    env,
    envVar: 'CEREBRAS_API_KEY',
  })
}

export const provider: ProviderConfig = {
  id: 'cerebras',
  displayName: 'Cerebras',
  authEnvVar: 'CEREBRAS_API_KEY',
  specSourceUrl: CEREBRAS_OPENAPI_URL,
  modelsEndpoint: CEREBRAS_MODELS_URL,
  defaultDerivation: 'upstream-spec',
  fetchSpec,
  listModels,
  classify,
}
