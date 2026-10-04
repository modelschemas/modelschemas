/**
 * Replicate — public OpenAPI at api.replicate.com/openapi.json.
 * Generation is POST /predictions (and official model run paths).
 * listModels walks the paginated public catalog; requires REPLICATE_API_TOKEN.
 */
import type { Activity } from '#/db/schema.ts'
import { cachedDocs, mapConcurrent } from '../model-facts.ts'
import { isoToEpochSeconds } from '../release-dates.ts'
import {
  fetchJson,
  fetchOpenApi,
  fetchText,
  sha256Text,
  skippedResult,
} from '../types.ts'
import {
  compileReplicateBilling,
  replicateBillingFromHtml,
} from '../replicate-pricing.ts'
import type { ReplicateBilling } from '../replicate-pricing.ts'
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
  created_at?: string
  is_official?: boolean
  latest_version?: { created_at?: string }
  /** Present when the models API includes the prediction price. */
  billing_config?: ReplicateBilling | null
  billingConfig?: ReplicateBilling | null
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

function modelPageUrl(owner: string, name: string): string {
  return `https://replicate.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
}

function inlineBilling(model: ReplicateModel): ReplicateBilling | null {
  const raw = model.billing_config ?? model.billingConfig
  if (!raw || typeof raw !== 'object') return null
  return raw
}

/**
 * Official models publish a prediction price on the model page (the models
 * list often omits it). A page with no billing config, or a fetch failure,
 * leaves the row unpriced. Community models are not fetched.
 */
async function withPredictionPrice(
  model: ReplicateModel,
  info: ModelInfo,
  kv?: KVNamespace,
): Promise<ModelInfo> {
  const owner = model.owner
  const name = model.name
  if (!owner || !name) return info
  const pageUrl = modelPageUrl(owner, name)
  const inline = inlineBilling(model)
  if (inline) {
    const extractedAt = new Date().toISOString()
    const source = {
      url: pageUrl,
      hash: await sha256Text(JSON.stringify(inline)),
      extractedAt,
    }
    const pricing = compileReplicateBilling(inline, source)
    if (!pricing) return info
    return {
      ...info,
      pricing,
      factSources: {
        pricing: {
          derivation: 'docs-derived',
          sourceUrl: pageUrl,
          sourceHash: source.hash,
          path: 'billing_config',
        },
      },
    }
  }
  if (model.is_official !== true) return info
  try {
    const doc = await cachedDocs(kv, pageUrl, async () => {
      const html = await fetchText(pageUrl)
      return {
        billing: replicateBillingFromHtml(html),
        hash: await sha256Text(html),
        extractedAt: new Date().toISOString(),
      }
    })
    const source = {
      url: pageUrl,
      hash: doc.hash,
      extractedAt: doc.extractedAt,
    }
    const pricing = compileReplicateBilling(doc.billing, source)
    if (!pricing) return info
    return {
      ...info,
      pricing,
      factSources: {
        pricing: {
          derivation: 'docs-derived',
          sourceUrl: pageUrl,
          sourceHash: doc.hash,
          path: 'billingConfig',
        },
      },
    }
  } catch {
    return info
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
      official: model.is_official,
    },
  }
}

async function listModels(
  env: ProviderSecrets,
  kv?: KVNamespace,
): Promise<ListModelsResult> {
  const key = env.REPLICATE_API_TOKEN
  if (!key) {
    return { models: [], ...skippedResult('replicate', 'REPLICATE_API_TOKEN') }
  }
  const headers = { Authorization: `Bearer ${key}` }
  const listed: Array<{ info: ModelInfo; model: ReplicateModel }> = []
  const seen = new Set<string>()
  let url: string | null = REPLICATE_MODELS_URL
  for (let page = 0; url && page < MAX_MODEL_PAGES; page++) {
    if (!isSafeModelsUrl(url)) break
    const body = (await fetchJson(url, { headers })) as ReplicateModelPage
    for (const row of body.results ?? []) {
      const info = toModelInfo(row)
      if (!info || seen.has(info.rawId)) continue
      seen.add(info.rawId)
      listed.push({ info, model: row })
    }
    url =
      typeof body.next === 'string' && body.next.length > 0 ? body.next : null
  }
  return {
    models: await mapConcurrent(listed, 8, ({ info, model }) =>
      withPredictionPrice(model, info, kv),
    ),
  }
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
