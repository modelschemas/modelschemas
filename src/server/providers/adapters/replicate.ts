/**
 * Replicate — public OpenAPI at api.replicate.com/openapi.json.
 * Generation is POST /predictions (and official model run paths).
 * listModels walks the paginated public catalog; requires REPLICATE_API_TOKEN.
 */
import type { Activity } from '#/db/schema.ts'
import { isoToEpochSeconds } from '../release-dates.ts'
import { fetchJson, fetchOpenApi, skippedResult } from '../types.ts'
import type {
  ListModelsResult,
  ModelInfo,
  OpenApiOperation,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

const REPLICATE_OPENAPI_URL = 'https://api.replicate.com/openapi.json'
const REPLICATE_MODELS_URL = 'https://api.replicate.com/v1/models'

/** Public catalog is huge; stay inside the Worker subrequest budget. */
const MAX_MODEL_PAGES = 20

function stripV1(path: string): string {
  return path.startsWith('/v1/') ? path.slice(3) : path
}

/**
 * Official-model slugs refine the activity. Generic prediction creates
 * (`/predictions`, templated `/models/{owner}/{name}/predictions`) default
 * to image — Replicate's core generation surface.
 */
function activityFromHaystack(haystack: string): Activity | null {
  const hay = haystack.toLowerCase()
  if (
    /text-to-video|image-to-video|video-to-video|stable-video|hunyuan-video|wan-video|ltx-video|cogvideo|animate-?diff|hailuo|kling|pixverse|runway|mochi-1|luma\/|\/veo|veo-\d|video-01|\/video-/.test(
      hay,
    )
  ) {
    return 'video'
  }
  if (
    /whisper|musicgen|audiogen|riffusion|text-to-speech|speech-to-text|text-to-audio|xtts|zonos|kokoro|chatterbox|\bbark\b|styletts|stable-audio|audio-ldm|mmaudio|ace-step|orpheus|\btts\b|voice-clone/.test(
      hay,
    )
  ) {
    return 'audio'
  }
  if (
    /llama|mistral|mixtral|qwen|gemma|deepseek|gpt-oss|phi-[34]|dbrx|nemotron|granite|arctic|\byi-|vicuna|wizardlm|zephyr|command-r|\bllm\b|instruct|\bchat\b/.test(
      hay,
    )
  ) {
    return 'chat'
  }
  if (
    /flux|sdxl|stable-diffusion|\bsd3\b|imagen|ideogram|recraft|playground|auraflow|hidream|seedream|esrgan|upscale|controlnet|pulid|text-to-image|image-to-image/.test(
      hay,
    )
  ) {
    return 'image'
  }
  return null
}

/** POST /predictions and POST /models/{owner}/{name}/predictions only. */
function isGenerationCreate(path: string): boolean {
  const bare = stripV1(path)
  if (bare === '/predictions') return true
  return /^\/models\/[^/]+\/[^/]+\/predictions$/.test(bare)
}

function classify(path: string, _op: OpenApiOperation): Activity | null {
  if (!isGenerationCreate(path)) return null
  return activityFromHaystack(path) ?? 'image'
}

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const { spec, hash } = await fetchOpenApi(REPLICATE_OPENAPI_URL)
  return {
    specs: [spec],
    sources: [{ url: REPLICATE_OPENAPI_URL, hash }],
    outputStrategy: 'post-200',
  }
}

interface ReplicateModel {
  owner?: string
  name?: string
  description?: string | null
  visibility?: string
  run_count?: number
  created_at?: string
  is_official?: boolean
  latest_version?: { created_at?: string }
}

interface ReplicateModelPage {
  next?: string | null
  results?: Array<ReplicateModel>
}

function isSafeModelsUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return (
      parsed.protocol === 'https:' &&
      parsed.hostname === 'api.replicate.com' &&
      parsed.pathname.startsWith('/v1/models')
    )
  } catch {
    return false
  }
}

function toModelInfo(model: ReplicateModel): ModelInfo | null {
  if (typeof model.owner !== 'string' || typeof model.name !== 'string') {
    return null
  }
  if (model.owner.length === 0 || model.name.length === 0) return null
  const rawId = `${model.owner}/${model.name}`
  return {
    rawId,
    displayName: model.name,
    activity: activityFromHaystack(`${rawId} ${model.description ?? ''}`),
    releasedAt:
      isoToEpochSeconds(model.created_at) ??
      isoToEpochSeconds(model.latest_version?.created_at),
    capabilities: {
      visibility: model.visibility,
      runCount: model.run_count,
      official: model.is_official,
    },
  }
}

async function listModels(env: ProviderSecrets): Promise<ListModelsResult> {
  const key = env.REPLICATE_API_TOKEN
  if (!key) {
    return { models: [], ...skippedResult('replicate', 'REPLICATE_API_TOKEN') }
  }
  const headers = { Authorization: `Bearer ${key}` }
  const models: Array<ModelInfo> = []
  const seen = new Set<string>()
  let url: string | null = REPLICATE_MODELS_URL
  for (let page = 0; url && page < MAX_MODEL_PAGES; page++) {
    if (!isSafeModelsUrl(url)) break
    const body = (await fetchJson(url, { headers })) as ReplicateModelPage
    for (const row of body.results ?? []) {
      const info = toModelInfo(row)
      if (!info || seen.has(info.rawId)) continue
      seen.add(info.rawId)
      models.push(info)
    }
    url =
      typeof body.next === 'string' && body.next.length > 0 ? body.next : null
  }
  return { models }
}

export const provider: ProviderConfig = {
  id: 'replicate',
  displayName: 'Replicate',
  authEnvVar: 'REPLICATE_API_TOKEN',
  specSourceUrl: REPLICATE_OPENAPI_URL,
  modelsEndpoint: REPLICATE_MODELS_URL,
  defaultDerivation: 'upstream-spec',
  fetchSpec,
  listModels,
  classify,
}
