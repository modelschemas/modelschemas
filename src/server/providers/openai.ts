/**
 * OpenAI — official OpenAPI spec published by OpenAI's Stainless-generated
 * SDKs. The `.stats.yml` in openai-node declares the current
 * `openapi_spec_url` (a hash-stamped YAML in GCS). This leads the public
 * github.com/openai/openai-openapi export, which lags behind API releases
 * (e.g. gpt-image-2 was in the Stainless spec's model enums while the
 * public repo still capped at gpt-image-1.5). Models endpoint requires
 * OPENAI_API_KEY.
 */
import { parse } from 'yaml'

import type { Activity } from '#/db/schema.ts'
import {
  fetchJson,
  fetchText,
  resolveStainlessSpecUrl,
  sha256Text,
  skippedResult,
} from './types.ts'
import type {
  ListModelsResult,
  OpenApiDocument,
  OpenApiOperation,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from './types.ts'

const OPENAI_STATS_URL =
  'https://raw.githubusercontent.com/openai/openai-node/master/.stats.yml'
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
  const specUrl = await resolveStainlessSpecUrl('openai', OPENAI_STATS_URL)
  const yamlText = await fetchText(specUrl)
  const spec = parse(yamlText) as OpenApiDocument
  return {
    specs: [spec],
    sources: [{ url: specUrl, hash: await sha256Text(yamlText) }],
    outputStrategy: 'post-200',
    specRevision: specUrl,
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
      releasedAt: m.created ?? null,
    })),
  }
}

export const openaiProvider: ProviderConfig = {
  id: 'openai',
  displayName: 'OpenAI',
  authEnvVar: 'OPENAI_API_KEY',
  fetchSpec,
  listModels,
  classify,
}
