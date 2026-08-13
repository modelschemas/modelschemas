/**
 * Runway — public Stainless spec from github.com/runwayml/openapi
 * (`next`/openapi.json; the README's openapi.yml path 404s). Generation
 * POSTs only; task GET/cancel, org, uploads, and CRUD classify null.
 * Runway has no /models list (`/v1/tasks` is per-id status) so listModels
 * skips without RUNWAY_API_KEY and otherwise returns an empty catalog.
 */
import type { Activity } from '#/db/schema.ts'
import { fetchOpenApi, skippedResult } from '../types.ts'
import type {
  ListModelsResult,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

const RUNWAY_OPENAPI_URL =
  'https://raw.githubusercontent.com/runwayml/openapi/next/openapi.json'
const RUNWAY_MODELS_URL = 'https://api.dev.runwayml.com/v1/tasks'

const VIDEO_PATHS = new Set([
  '/v1/image_to_video',
  '/v1/text_to_video',
  '/v1/video_to_video',
  '/v1/video_upscale',
  '/v1/character_performance',
  '/v1/generate/video',
  '/v1/avatar_videos',
  '/v1/recipes/product_ad',
  '/v1/recipes/product_swap',
  '/v1/recipes/multi_shot_video',
  '/v1/recipes/product_ugc',
])

const IMAGE_PATHS = new Set([
  '/v1/text_to_image',
  '/v1/image_upscale',
  '/v1/generate/image',
  '/v1/recipes/ad_localization',
  '/v1/recipes/marketing_stock_image',
  '/v1/recipes/product_campaign_image',
])

const AUDIO_PATHS = new Set([
  '/v1/sound_effect',
  '/v1/speech_to_speech',
  '/v1/text_to_speech',
  '/v1/voice_dubbing',
  '/v1/voice_isolation',
  '/v1/generate/audio',
])

/**
 * Path-based: the shared "Start generating" tag mixes video, image, and
 * audio. Task management, organization, uploads, avatars/voices CRUD,
 * routers, workflows, and knowledge are platform.
 */
function classify(path: string): Activity | null {
  const bare = path.split('?')[0] ?? path
  if (VIDEO_PATHS.has(bare)) return 'video'
  if (IMAGE_PATHS.has(bare)) return 'image'
  if (AUDIO_PATHS.has(bare)) return 'audio'
  return null
}

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const { spec, hash } = await fetchOpenApi(RUNWAY_OPENAPI_URL)
  return {
    specs: [spec],
    sources: [{ url: RUNWAY_OPENAPI_URL, hash }],
    outputStrategy: 'post-200',
  }
}

async function listModels(env: ProviderSecrets): Promise<ListModelsResult> {
  if (!env.RUNWAY_API_KEY) {
    return { models: [], ...skippedResult('runway', 'RUNWAY_API_KEY') }
  }
  return { models: [] }
}

export const provider: ProviderConfig = {
  id: 'runway',
  displayName: 'Runway',
  authEnvVar: 'RUNWAY_API_KEY',
  specSourceUrl: RUNWAY_OPENAPI_URL,
  modelsEndpoint: RUNWAY_MODELS_URL,
  defaultDerivation: 'upstream-spec',
  fetchSpec,
  listModels,
  classify,
}
