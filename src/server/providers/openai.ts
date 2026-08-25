/**
 * OpenAI — spec from openai-node's `api_reference/openapi.transformed.yml`
 * (Castiron generation input). This leads the public openai-openapi export,
 * which lags API releases (gpt-image-2 is enum-typed here; the public repo
 * still caps at gpt-image-1.5). Models endpoint requires OPENAI_API_KEY.
 */
import type { Activity } from '#/db/schema.ts'
import { bearerConnect } from './connect.ts'
import {
  displayNameFromRawId,
  openaiGenerationEndpointId,
  openaiModelActivity,
} from './model-meta.ts'
import { fetchJson, fetchOpenApi, skippedResult } from './types.ts'
import type {
  ListModelsResult,
  OpenApiOperation,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from './types.ts'

export const OPENAI_SPEC_URL =
  'https://raw.githubusercontent.com/openai/openai-node/main/api_reference/openapi.transformed.yml'
const OPENAI_MODELS_URL = 'https://api.openai.com/v1/models'

/**
 * Tag → activity mapping. Tags absent from this map (Assistants, Batch,
 * Files, Fine-tuning, Vector stores, and the organization/admin surface)
 * are platform endpoints and classify to null.
 */
const OPENAI_TAG_ACTIVITIES: Record<string, Activity> = {
  Chat: 'chat',
  Completions: 'chat',
  Responses: 'chat',
  Conversations: 'chat',
  Realtime: 'chat',
  Audio: 'audio',
  Images: 'image',
  Videos: 'video',
  Embeddings: 'embeddings',
  Moderations: 'moderation',
}

function classify(path: string, op: OpenApiOperation): Activity | null {
  const tags = Array.isArray(op.tags) ? (op.tags as Array<string>) : []
  for (const tag of tags) {
    const activity = OPENAI_TAG_ACTIVITIES[tag]
    if (activity) return activity
  }
  // A handful of Responses-API operations ship untagged
  // (/responses/input_tokens, /responses/compact).
  if (path.startsWith('/responses')) return 'chat'
  return null
}

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const { spec, hash } = await fetchOpenApi(OPENAI_SPEC_URL)
  return {
    specs: [spec],
    sources: [{ url: OPENAI_SPEC_URL, hash }],
    outputStrategy: 'post-200',
    // Floating `main` URL — the document hash is the revision id.
    specRevision: hash,
  }
}

interface OpenAiModelList {
  data?: Array<{ id: string; created?: number }>
}

async function listModels(env: ProviderSecrets): Promise<ListModelsResult> {
  const key = env.OPENAI_API_KEY
  if (!key) {
    return { models: [], ...skippedResult('openai', 'OPENAI_API_KEY') }
  }
  const body = (await fetchJson(OPENAI_MODELS_URL, {
    headers: { Authorization: `Bearer ${key}` },
  })) as OpenAiModelList
  return {
    models: (body.data ?? []).map((m) => ({
      rawId: m.id,
      displayName: displayNameFromRawId(m.id),
      activity: openaiModelActivity(m.id),
      releasedAt: m.created ?? null,
    })),
  }
}

export const openaiProvider: ProviderConfig = {
  id: 'openai',
  displayName: 'OpenAI',
  authEnvVar: 'OPENAI_API_KEY',
  defaultDerivation: 'upstream-spec',
  specGrain: 'provider',
  connect: bearerConnect('https://api.openai.com/v1'),
  fetchSpec,
  listModels,
  classify,
  generationEndpointId: ({ rawId, activity }) =>
    openaiGenerationEndpointId(rawId, activity),
}
