/**
 * Deepgram — public OpenAPI at developers.deepgram.com/openapi.json
 * (mirrored at github.com/deepgram/deepgram-api-specs). Models list
 * requires DEEPGRAM_API_KEY. Auth is `Authorization: Token`.
 */
import type { Activity } from '#/db/schema.ts'
import { fetchJson, fetchOpenApi, skippedResult } from '../types.ts'
import type {
  ListModelsResult,
  ModelInfo,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

const DEEPGRAM_OPENAPI_URL = 'https://developers.deepgram.com/openapi.json'
const DEEPGRAM_MODELS_URL = 'https://api.deepgram.com/v1/models'

/**
 * Listen (STT), Speak (TTS), and Voice Agent converse are audio
 * generation. Project/key/auth management and `/v1/read` (text
 * intelligence — no matching activity) classify to null.
 */
function classify(path: string): Activity | null {
  const bare = path.split('?')[0] ?? path
  if (
    bare === '/v1/listen' ||
    bare === '/v2/listen' ||
    bare.startsWith('/v1/listen/') ||
    bare.startsWith('/v2/listen/')
  ) {
    return 'audio'
  }
  if (
    bare === '/v1/speak' ||
    bare === '/v2/speak' ||
    bare.startsWith('/v1/speak/') ||
    bare.startsWith('/v2/speak/')
  ) {
    return 'audio'
  }
  if (bare === '/v1/agent/converse' || bare.startsWith('/v1/agent/converse/')) {
    return 'audio'
  }
  return null
}

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const { spec, hash } = await fetchOpenApi(DEEPGRAM_OPENAPI_URL)
  return {
    specs: [spec],
    sources: [{ url: DEEPGRAM_OPENAPI_URL, hash }],
    outputStrategy: 'post-200',
  }
}

interface DeepgramListedModel {
  name?: string
  canonical_name?: string
}

interface DeepgramModelList {
  stt?: Array<DeepgramListedModel>
  tts?: Array<DeepgramListedModel>
}

function listedModel(entry: DeepgramListedModel): ModelInfo | null {
  const rawId = entry.canonical_name ?? entry.name
  if (typeof rawId !== 'string' || rawId.length === 0) return null
  return {
    rawId,
    displayName: entry.name ?? rawId,
    activity: 'audio',
  }
}

async function listModels(env: ProviderSecrets): Promise<ListModelsResult> {
  const key = env.DEEPGRAM_API_KEY
  if (!key) {
    return { models: [], ...skippedResult('deepgram', 'DEEPGRAM_API_KEY') }
  }
  const body = (await fetchJson(DEEPGRAM_MODELS_URL, {
    headers: { Authorization: `Token ${key}` },
  })) as DeepgramModelList
  const models: Array<ModelInfo> = []
  const seen = new Set<string>()
  for (const entry of [...(body.stt ?? []), ...(body.tts ?? [])]) {
    const model = listedModel(entry)
    if (!model || seen.has(model.rawId)) continue
    seen.add(model.rawId)
    models.push(model)
  }
  return { models }
}

export const provider: ProviderConfig = {
  id: 'deepgram',
  displayName: 'Deepgram',
  authEnvVar: 'DEEPGRAM_API_KEY',
  specSourceUrl: DEEPGRAM_OPENAPI_URL,
  modelsEndpoint: DEEPGRAM_MODELS_URL,
  defaultDerivation: 'upstream-spec',
  fetchSpec,
  listModels,
  classify,
}
