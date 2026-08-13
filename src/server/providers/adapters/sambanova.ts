/**
 * SambaNova Cloud — OpenAI-compatible inference API. No public spec
 * (hinted docs URL 404s; Stainless .stats.yml has no openapi_spec_url),
 * so schemas are generated from the OpenAI document.
 */
import {
  OPENAI_OPENAPI_URL,
  classifyOpenAiCompat,
  fetchOpenAiCompatibleSpec,
  listOpenAiCompatibleModels,
} from '../openai-compat.ts'
import type {
  ListModelsResult,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

const MODELS_URL = 'https://api.sambanova.ai/v1/models'
const SERVER_URL = 'https://api.sambanova.ai/v1'

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const { spec, url, hash } = await fetchOpenAiCompatibleSpec({
    title: 'SambaNova',
    serverUrl: SERVER_URL,
    include: ['/chat/completions'],
  })
  return {
    specs: [spec],
    sources: [{ url, hash }],
    outputStrategy: 'post-200',
  }
}

async function listModels(env: ProviderSecrets): Promise<ListModelsResult> {
  return listOpenAiCompatibleModels({
    providerId: 'sambanova',
    url: MODELS_URL,
    env,
    envVar: 'SAMBANOVA_API_KEY',
  })
}

export const provider: ProviderConfig = {
  id: 'sambanova',
  displayName: 'SambaNova',
  authEnvVar: 'SAMBANOVA_API_KEY',
  specSourceUrl: OPENAI_OPENAPI_URL,
  modelsEndpoint: MODELS_URL,
  defaultDerivation: 'generated',
  fetchSpec,
  listModels,
  classify: classifyOpenAiCompat,
}
