/**
 * Novita AI — OpenAI-compatible chat + image. No schema-bearing spec
 * (docs.novita.ai/openapi.json is HTML; novita.ai/.well-known/openapi.json
 * is a path-only discovery stub). Generated from the OpenAI document.
 * Official host is api.novita.ai/openai/v1 (the older /v3/openai prefix
 * still appears in some clients).
 */
import {
  classifyOpenAiCompat,
  fetchOpenAiCompatibleSpec,
  listOpenAiCompatibleModels,
  OPENAI_OPENAPI_URL,
} from '../openai-compat.ts'
import type {
  ListModelsResult,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

const NOVITA_SERVER_URL = 'https://api.novita.ai/openai/v1'
const NOVITA_MODELS_URL = 'https://api.novita.ai/openai/v1/models'

const INCLUDE = ['/chat/completions', '/images/generations'] as const

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const { spec, url, hash } = await fetchOpenAiCompatibleSpec({
    title: 'Novita AI',
    serverUrl: NOVITA_SERVER_URL,
    include: INCLUDE,
  })
  return {
    specs: [spec],
    sources: [{ url, hash }],
    outputStrategy: 'post-200',
  }
}

function listModels(env: ProviderSecrets): Promise<ListModelsResult> {
  return listOpenAiCompatibleModels({
    providerId: 'novita',
    url: NOVITA_MODELS_URL,
    env,
    envVar: 'NOVITA_API_KEY',
  })
}

export const provider: ProviderConfig = {
  id: 'novita',
  displayName: 'Novita AI',
  authEnvVar: 'NOVITA_API_KEY',
  specSourceUrl: OPENAI_OPENAPI_URL,
  modelsEndpoint: NOVITA_MODELS_URL,
  defaultDerivation: 'generated',
  fetchSpec,
  listModels,
  classify: classifyOpenAiCompat,
}
