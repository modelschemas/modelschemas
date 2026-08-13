/**
 * Hyperbolic — OpenAI-compatible inference API. No public spec; schemas
 * are generated from the canonical OpenAI document.
 */
import {
  classifyOpenAiCompat,
  fetchOpenAiCompatibleSpec,
  listOpenAiCompatibleModels,
} from '../openai-compat.ts'
import type {
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

const HYPERBOLIC_DOCS_URL = 'https://docs.hyperbolic.xyz'
const HYPERBOLIC_MODELS_URL = 'https://api.hyperbolic.xyz/v1/models'
const HYPERBOLIC_SERVER_URL = 'https://api.hyperbolic.xyz/v1'

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const { spec, url, hash } = await fetchOpenAiCompatibleSpec({
    title: 'Hyperbolic',
    serverUrl: HYPERBOLIC_SERVER_URL,
    include: ['/chat/completions'],
  })
  return {
    specs: [spec],
    sources: [{ url, hash }],
    outputStrategy: 'post-200',
  }
}

export const provider: ProviderConfig = {
  id: 'hyperbolic',
  displayName: 'Hyperbolic',
  authEnvVar: 'HYPERBOLIC_API_KEY',
  specSourceUrl: HYPERBOLIC_DOCS_URL,
  modelsEndpoint: HYPERBOLIC_MODELS_URL,
  defaultDerivation: 'generated',
  fetchSpec,
  listModels: (env) =>
    listOpenAiCompatibleModels({
      providerId: 'hyperbolic',
      url: HYPERBOLIC_MODELS_URL,
      env,
      envVar: 'HYPERBOLIC_API_KEY',
    }),
  classify: classifyOpenAiCompat,
}
