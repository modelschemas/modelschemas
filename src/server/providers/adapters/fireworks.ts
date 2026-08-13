/**
 * Fireworks AI — official text-completion OpenAPI at
 * docs.fireworks.ai/text-completion.openapi.yaml (public). The hinted
 * api-reference page is HTML, not a spec; the published YAML covers
 * POST /v1/chat/completions and /v1/completions. Models list needs
 * FIREWORKS_API_KEY.
 */
import type { Activity } from '#/db/schema.ts'
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

const FIREWORKS_SPEC_URL =
  'https://docs.fireworks.ai/text-completion.openapi.yaml'
const FIREWORKS_MODELS_URL = 'https://api.fireworks.ai/inference/v1/models'

/**
 * Inference paths may be served under /inference (docs) or as the OpenAI
 * /v1-prefixed forms in the published spec. Anthropic-compatible /messages
 * is chat; rerank and the account control plane are platform.
 */
function classify(path: string): Activity | null {
  const stripped = path.startsWith('/inference/')
    ? path.slice('/inference'.length)
    : path
  const activity = classifyOpenAiCompat(stripped)
  if (activity) return activity
  const bare = stripped.startsWith('/v1/') ? stripped.slice(3) : stripped
  if (bare === '/messages') return 'chat'
  return null
}

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const { spec, hash } = await fetchOpenApi(FIREWORKS_SPEC_URL)
  return {
    specs: [spec],
    sources: [{ url: FIREWORKS_SPEC_URL, hash }],
    outputStrategy: 'post-200',
  }
}

async function listModels(env: ProviderSecrets): Promise<ListModelsResult> {
  return listOpenAiCompatibleModels({
    providerId: 'fireworks',
    url: FIREWORKS_MODELS_URL,
    env,
    envVar: 'FIREWORKS_API_KEY',
  })
}

export const provider: ProviderConfig = {
  id: 'fireworks',
  displayName: 'Fireworks AI',
  authEnvVar: 'FIREWORKS_API_KEY',
  specSourceUrl: FIREWORKS_SPEC_URL,
  modelsEndpoint: FIREWORKS_MODELS_URL,
  defaultDerivation: 'upstream-spec',
  fetchSpec,
  listModels,
  classify,
}
