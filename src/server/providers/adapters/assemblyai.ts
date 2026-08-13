/**
 * AssemblyAI — public OpenAPI 3.1 titled "AssemblyAI API" at
 * www.assemblyai.com/docs/openapi.json (the hinted /openapi.json 308s
 * here). Do not fetch /docs/api-reference/openapi.json — that is Mintlify's
 * plant-store placeholder. No classic /models list; listModels returns a
 * small curated speech-model catalog when ASSEMBLYAI_API_KEY is set.
 */
import type { Activity } from '#/db/schema.ts'
import { fetchOpenApi, skippedResult } from '../types.ts'
import type {
  ListModelsResult,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

const ASSEMBLYAI_OPENAPI_URL = 'https://www.assemblyai.com/docs/openapi.json'
/** Stand-in: AssemblyAI has no GET /models. */
const ASSEMBLYAI_MODELS_URL = 'https://api.assemblyai.com/v2/transcript'

/**
 * Speech model ids from the published spec's `SpeechModel` enum. Used as
 * the catalog because there is no list-models endpoint.
 */
const CURATED_SPEECH_MODELS: ReadonlyArray<{
  rawId: string
  displayName: string
}> = [
  { rawId: 'universal-3-5-pro', displayName: 'Universal 3.5 Pro' },
  { rawId: 'universal-2', displayName: 'Universal-2' },
]

/**
 * Generation surface only. POST /v2/transcript submits STT; websocket
 * streaming paths classify audio if a later spec revision includes them.
 * Upload, transcript GET/DELETE, subtitle/sentence helpers, and Lemur
 * classify to null.
 */
function classify(path: string): Activity | null {
  const bare = path.includes('#') ? path.slice(0, path.indexOf('#')) : path
  if (bare === '/v2/transcript') return 'audio'
  if (bare === '/v2/realtime/ws' || bare === '/v3/ws') return 'audio'
  return null
}

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const { spec, hash } = await fetchOpenApi(ASSEMBLYAI_OPENAPI_URL)
  return {
    specs: [spec],
    sources: [{ url: ASSEMBLYAI_OPENAPI_URL, hash }],
    outputStrategy: 'post-200',
  }
}

async function listModels(env: ProviderSecrets): Promise<ListModelsResult> {
  if (!env.ASSEMBLYAI_API_KEY) {
    return { models: [], ...skippedResult('assemblyai', 'ASSEMBLYAI_API_KEY') }
  }
  return {
    models: CURATED_SPEECH_MODELS.map((m) => ({
      rawId: m.rawId,
      displayName: m.displayName,
      activity: 'audio' as const,
      releasedAt: null,
    })),
  }
}

export const provider: ProviderConfig = {
  id: 'assemblyai',
  displayName: 'AssemblyAI',
  authEnvVar: 'ASSEMBLYAI_API_KEY',
  specSourceUrl: ASSEMBLYAI_OPENAPI_URL,
  modelsEndpoint: ASSEMBLYAI_MODELS_URL,
  defaultDerivation: 'upstream-spec',
  fetchSpec,
  listModels,
  classify,
}
