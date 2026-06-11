/**
 * xAI Grok — first-party OpenAPI 3.1 spec at docs.x.ai/openapi.json
 * (public). Provider id `grok` matches the @tanstack/ai-grok adapter even
 * though xAI titles the spec "xAI's REST API".
 */
import type { Activity } from '#/db/schema.ts'
import { fetchJson, skippedResult } from './types.ts'
import type {
  ListModelsResult,
  OpenApiDocument,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from './types.ts'

const GROK_OPENAPI_URL = 'https://docs.x.ai/openapi.json'
const GROK_MODELS_URL = 'https://api.x.ai/v1/models'

/**
 * xAI tags every operation `v1`, so classify by path. The text-generation
 * surface spans the OpenAI-compatible endpoints (chat/completions,
 * completions, responses) and the Anthropic-compatible ones (messages,
 * complete). Files and document search are platform endpoints.
 */
function classify(path: string): Activity | null {
  if (
    path === '/v1/chat/completions' ||
    path === '/v1/completions' ||
    path === '/v1/complete' ||
    path === '/v1/messages' ||
    path === '/v1/responses' ||
    path === '/v1/tokenize-text'
  ) {
    return 'chat'
  }
  if (path.startsWith('/v1/images/')) return 'image'
  if (path.startsWith('/v1/videos/')) return 'video'
  if (path === '/v1/embeddings') return 'embeddings'
  return null
}

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const spec = (await fetchJson(GROK_OPENAPI_URL)) as OpenApiDocument
  return { specs: [spec], outputStrategy: 'post-200' }
}

interface GrokModelList {
  data?: Array<{ id: string }>
}

async function listModels(env: ProviderSecrets): Promise<ListModelsResult> {
  const key = env.XAI_API_KEY
  if (!key) {
    return { models: [], ...skippedResult('grok', 'XAI_API_KEY') }
  }
  const body = (await fetchJson(GROK_MODELS_URL, {
    headers: { Authorization: `Bearer ${key}` },
  })) as GrokModelList
  return { models: (body.data ?? []).map((m) => ({ rawId: m.id })) }
}

export const grokProvider: ProviderConfig = {
  id: 'grok',
  displayName: 'xAI Grok',
  authEnvVar: 'XAI_API_KEY',
  fetchSpec,
  listModels,
  classify,
}
