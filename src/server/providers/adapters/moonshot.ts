/**
 * Moonshot (Kimi) — international surface. Spec is
 * platform.kimi.ai/docs/openapi.json (`servers.url` = api.moonshot.ai).
 * Keys are region-bound: this host accepts international keys; a CN key
 * 401s here the same way an international key 401s on api.moonshot.cn.
 * Generation is POST /v1/chat/completions; files, batches, billing, and
 * token-estimate classify as platform.
 */
import {
  classifyOpenAiCompat,
  listOpenAiCompatibleModels,
} from '../openai-compat.ts'
import { fetchOpenApi } from '../types.ts'
import type {
  ListModelsResult,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

const MOONSHOT_OPENAPI_URL = 'https://platform.kimi.ai/docs/openapi.json'
const MOONSHOT_MODELS_URL = 'https://api.moonshot.ai/v1/models'

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const { spec, hash } = await fetchOpenApi(MOONSHOT_OPENAPI_URL)
  return {
    specs: [spec],
    sources: [{ url: MOONSHOT_OPENAPI_URL, hash }],
    outputStrategy: 'post-200',
  }
}

async function listModels(env: ProviderSecrets): Promise<ListModelsResult> {
  return listOpenAiCompatibleModels({
    providerId: 'moonshot',
    url: MOONSHOT_MODELS_URL,
    env,
    envVar: 'MOONSHOT_API_KEY',
  })
}

export const provider: ProviderConfig = {
  id: 'moonshot',
  displayName: 'Moonshot',
  authEnvVar: 'MOONSHOT_API_KEY',
  specSourceUrl: MOONSHOT_OPENAPI_URL,
  modelsEndpoint: MOONSHOT_MODELS_URL,
  defaultDerivation: 'upstream-spec',
  fetchSpec,
  listModels,
  classify: classifyOpenAiCompat,
}
