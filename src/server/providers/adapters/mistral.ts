/**
 * Mistral — public OpenAPI 3.1 at docs.mistral.ai/openapi.yaml.
 * Models listing requires MISTRAL_API_KEY.
 */
import type { Activity } from '#/db/schema.ts'
import { fetchJson, fetchOpenApi, skippedResult } from '../types.ts'
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

interface MistralModelList {
  data?: Array<{ id: string; created?: number }>
}

async function listModels(env: ProviderSecrets): Promise<ListModelsResult> {
  const key = env.MISTRAL_API_KEY
  if (!key) {
    return { models: [], ...skippedResult('mistral', 'MISTRAL_API_KEY') }
  }
  const body = (await fetchJson(MISTRAL_MODELS_URL, {
    headers: { Authorization: `Bearer ${key}` },
  })) as MistralModelList
  return {
    models: (body.data ?? [])
      .filter((m) => typeof m.id === 'string' && m.id.length > 0)
      .map((m) => ({
        rawId: m.id,
        releasedAt: m.created ?? null,
      })),
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
  listModels,
  classify,
}
