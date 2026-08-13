/**
 * Groq — official OpenAPI spec published by Groq's Stainless-generated
 * SDKs. groq-python `.stats.yml` declares the current `openapi_spec_url`
 * (a hash-stamped YAML in GCS that updates whenever Groq ships a new API
 * revision). The hinted console URL is docs, not a spec.
 */
import type { Activity } from '#/db/schema.ts'
import {
  classifyOpenAiCompat,
  listOpenAiCompatibleModels,
} from '../openai-compat.ts'
import { fetchOpenApi, fetchText } from '../types.ts'
import type {
  ListModelsResult,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

const GROQ_STATS_URL =
  'https://raw.githubusercontent.com/groq/groq-python/main/.stats.yml'
const GROQ_MODELS_URL = 'https://api.groq.com/openai/v1/models'

async function resolveGroqSpecUrl(): Promise<string> {
  const text = await fetchText(GROQ_STATS_URL)
  const match = text.match(/^openapi_spec_url:\s*(.+)$/m)
  if (!match?.[1]) {
    throw new Error("groq .stats.yml: couldn't find openapi_spec_url")
  }
  return match[1].trim()
}

/**
 * Stainless paths are `/openai/v1/...` (server is `https://api.groq.com`).
 * Strip that prefix and reuse the OpenAI-compat path map. Batches, files,
 * fine-tunes, models, and rerank classify null.
 */
function classify(path: string): Activity | null {
  const withoutOpenAi = path.startsWith('/openai/')
    ? path.slice('/openai'.length)
    : path
  return classifyOpenAiCompat(withoutOpenAi)
}

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const specUrl = await resolveGroqSpecUrl()
  const { spec, hash } = await fetchOpenApi(specUrl)
  return {
    specs: [spec],
    sources: [{ url: specUrl, hash }],
    outputStrategy: 'post-200',
    specRevision: specUrl,
  }
}

async function listModels(env: ProviderSecrets): Promise<ListModelsResult> {
  return listOpenAiCompatibleModels({
    providerId: 'groq',
    url: GROQ_MODELS_URL,
    env,
    envVar: 'GROQ_API_KEY',
  })
}

export const provider: ProviderConfig = {
  id: 'groq',
  displayName: 'Groq',
  authEnvVar: 'GROQ_API_KEY',
  specSourceUrl: GROQ_STATS_URL,
  modelsEndpoint: GROQ_MODELS_URL,
  defaultDerivation: 'upstream-spec',
  fetchSpec,
  listModels,
  classify,
}
