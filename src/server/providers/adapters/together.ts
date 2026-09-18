/**
 * Together AI — public OpenAPI 3.1 at docs.together.ai/openapi.yaml.
 * Generation: chat/completions, embeddings, images, video, audio.
 * Platform/admin (files, fine-tunes, endpoints, batches, rerank) classify
 * null. listModels requires TOGETHER_API_KEY; Together returns a bare array.
 */
import { compileTokenCard } from '@modelschemas/rate-card'

import type { Activity } from '#/db/schema.ts'
import { fetchJson, fetchOpenApi, sha256Text, skippedResult } from '../types.ts'
import type { RateCard } from '@modelschemas/rate-card'
import type {
  ListModelsResult,
  ModelInfo,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

const TOGETHER_OPENAPI_URL = 'https://docs.together.ai/openapi.yaml'
const TOGETHER_MODELS_URL = 'https://api.together.xyz/v1/models'

const MODEL_TYPE_ACTIVITY: Record<string, Activity> = {
  chat: 'chat',
  language: 'chat',
  code: 'chat',
  image: 'image',
  video: 'video',
  audio: 'audio',
  embedding: 'embeddings',
  embeddings: 'embeddings',
  moderation: 'moderation',
}

function barePath(path: string): string {
  return path.replace(/^\/v\d+/, '')
}

function classify(path: string): Activity | null {
  const bare = barePath(path)
  if (bare === '/chat/completions' || bare === '/completions') return 'chat'
  if (bare === '/embeddings') return 'embeddings'
  if (bare === '/images/generations') return 'image'
  if (bare === '/videos') return 'video'
  if (
    bare === '/audio/speech' ||
    bare === '/audio/transcriptions' ||
    bare === '/audio/translations'
  ) {
    return 'audio'
  }
  return null
}

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const { spec, hash } = await fetchOpenApi(TOGETHER_OPENAPI_URL)
  return {
    specs: [spec],
    sources: [{ url: TOGETHER_OPENAPI_URL, hash }],
    outputStrategy: 'post-200',
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function asModels(body: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(body)) {
    return body.filter((item): item is Record<string, unknown> =>
      isRecord(item),
    )
  }
  if (isRecord(body) && Array.isArray(body.data)) {
    return body.data.filter((item): item is Record<string, unknown> =>
      isRecord(item),
    )
  }
  return []
}

/**
 * Together prices per million tokens on the listing (`{ input: 0.88,
 * output: 0.88, hourly: 0, base: 0, finetune: 0 }`), and serves an all-zero
 * object for models it does not quote — those are unknown, not free, so
 * they compile to null rather than a $0 card. `hourly`/`base`/`finetune`
 * are dedicated-endpoint and training rates, not per-request levers.
 */
export async function togetherRateCard(
  pricing: unknown,
): Promise<RateCard | null> {
  if (!isRecord(pricing)) return null
  const perToken = (key: string): number | null =>
    typeof pricing[key] === 'number' ? pricing[key] / 1e6 : null
  const rates: Record<string, number> = {}
  const input = perToken('input')
  const output = perToken('output')
  if (input !== null) rates.input_tokens = input
  if (output !== null) rates.output_tokens = output
  return compileTokenCard(rates, [], {
    url: TOGETHER_MODELS_URL,
    hash: await sha256Text(JSON.stringify(pricing)),
    extractedAt: new Date().toISOString(),
  })
}

async function listModels(env: ProviderSecrets): Promise<ListModelsResult> {
  const key = env.TOGETHER_API_KEY
  if (!key) {
    return { models: [], ...skippedResult('together', 'TOGETHER_API_KEY') }
  }
  const body = await fetchJson(TOGETHER_MODELS_URL, {
    headers: { Authorization: `Bearer ${key}` },
  })
  const models: Array<ModelInfo> = []
  for (const item of asModels(body)) {
    if (typeof item.id !== 'string' || item.id.length === 0) continue
    const type = item.type
    const activity =
      typeof type === 'string' ? (MODEL_TYPE_ACTIVITY[type] ?? null) : null
    const model: ModelInfo = {
      rawId: item.id,
      displayName:
        typeof item.display_name === 'string' ? item.display_name : null,
      activity,
      contextWindow:
        typeof item.context_length === 'number' ? item.context_length : null,
      releasedAt: typeof item.created === 'number' ? item.created : null,
    }
    const card = await togetherRateCard(item.pricing)
    if (card) model.pricing = card
    models.push(model)
  }
  return { models }
}

export const provider: ProviderConfig = {
  id: 'together',
  displayName: 'Together AI',
  authEnvVar: 'TOGETHER_API_KEY',
  specSourceUrl: TOGETHER_OPENAPI_URL,
  modelsEndpoint: TOGETHER_MODELS_URL,
  defaultDerivation: 'upstream-spec',
  fetchSpec,
  listModels,
  classify,
}
