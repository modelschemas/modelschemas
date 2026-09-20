/**
 * Groq — official OpenAPI spec bundled in Groq's Stainless-generated Python
 * SDK: `scripts/mock` embeds it as base64+gzip `EMBEDDED_SPEC` (refreshed on
 * every SDK codegen). `.stats.yml` stopped carrying `openapi_spec_url` on
 * 2026-08-11. The hinted console URL is docs, not a spec.
 */
import type { Activity } from '#/db/schema.ts'
import {
  classifyOpenAiCompat,
  listOpenAiCompatibleModels,
} from '../openai-compat.ts'
import { fetchText, parseGzippedOpenApi } from '../types.ts'
import type {
  ListModelsResult,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

const GROQ_MOCK_URL =
  'https://raw.githubusercontent.com/groq/groq-python/main/scripts/mock'
const GROQ_MODELS_URL = 'https://api.groq.com/openai/v1/models'

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
  const script = await fetchText(GROQ_MOCK_URL)
  const blob = script.match(/EMBEDDED_SPEC="([A-Za-z0-9+/=\s]+)"/)?.[1]
  if (!blob) {
    throw new Error(`groq: no EMBEDDED_SPEC in ${GROQ_MOCK_URL}`)
  }
  const bytes = Uint8Array.from(atob(blob.replace(/\s/g, '')), (c) =>
    c.charCodeAt(0),
  )
  return parseGzippedOpenApi(bytes, 'groq', GROQ_MOCK_URL)
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
  specSourceUrl: GROQ_MOCK_URL,
  modelsEndpoint: GROQ_MODELS_URL,
  defaultDerivation: 'upstream-spec',
  fetchSpec,
  listModels,
  classify,
}
