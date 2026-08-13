/**
 * DeepSeek — OpenAI-compatible chat API. No published OpenAPI document;
 * schemas are generated from the canonical OpenAI spec. Official host is
 * https://api.deepseek.com (POST /chat/completions, no /v1 prefix).
 */
import {
  classifyOpenAiCompat,
  fetchOpenAiCompatibleSpec,
  listOpenAiCompatibleModels,
  OPENAI_OPENAPI_URL,
} from '../openai-compat.ts'
import type {
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

const DEEPSEEK_SERVER_URL = 'https://api.deepseek.com'
const DEEPSEEK_MODELS_URL = 'https://api.deepseek.com/models'

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const { spec, url, hash } = await fetchOpenAiCompatibleSpec({
    title: 'DeepSeek',
    serverUrl: DEEPSEEK_SERVER_URL,
    include: ['/chat/completions'],
  })
  return {
    specs: [spec],
    sources: [{ url, hash }],
    outputStrategy: 'post-200',
  }
}

export const provider: ProviderConfig = {
  id: 'deepseek',
  displayName: 'DeepSeek',
  authEnvVar: 'DEEPSEEK_API_KEY',
  specSourceUrl: OPENAI_OPENAPI_URL,
  modelsEndpoint: DEEPSEEK_MODELS_URL,
  defaultDerivation: 'generated',
  fetchSpec,
  listModels: (env) =>
    listOpenAiCompatibleModels({
      providerId: 'deepseek',
      url: DEEPSEEK_MODELS_URL,
      env,
      envVar: 'DEEPSEEK_API_KEY',
    }),
  classify: (path) => classifyOpenAiCompat(path),
}
