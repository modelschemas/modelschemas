/**
 * Anthropic — official OpenAPI spec published by Anthropic's
 * Stainless-generated SDKs. The `.stats.yml` in anthropic-sdk-typescript
 * declares the current `openapi_spec_url` (a hash-stamped YAML in GCS that
 * updates whenever Anthropic ships a new API revision) — that URL doubles
 * as our specRevision.
 */
import { parse } from 'yaml'

import type { Activity } from '#/db/schema.ts'
import { isoToEpochSeconds } from './release-dates.ts'
import { fetchJson, fetchText, sha256Text, skippedResult } from './types.ts'
import type {
  ListModelsResult,
  OpenApiDocument,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from './types.ts'

const ANTHROPIC_STATS_URL =
  'https://raw.githubusercontent.com/anthropics/anthropic-sdk-typescript/main/.stats.yml'
const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models'
const ANTHROPIC_VERSION = '2023-06-01'

export async function resolveAnthropicSpecUrl(): Promise<string> {
  const text = await fetchText(ANTHROPIC_STATS_URL)
  // .stats.yml is plain YAML key-value; we only need one field, so avoid a
  // full YAML parse for the common case.
  const match = text.match(/^openapi_spec_url:\s*(.+)$/m)
  if (!match?.[1]) {
    throw new Error("anthropic .stats.yml: couldn't find openapi_spec_url")
  }
  return match[1].trim()
}

/**
 * Anthropic's generation surface is messages + the legacy text completion
 * (plus `?beta=true` variants and token counting). Batches, files, skills,
 * and the agent-platform surfaces are platform endpoints.
 */
function classify(path: string): Activity | null {
  const bare = path.replace(/\?beta=true$/, '')
  if (bare.startsWith('/v1/messages/batches')) return null
  if (bare === '/v1/messages' || bare === '/v1/messages/count_tokens') {
    return 'chat'
  }
  if (bare === '/v1/complete') return 'chat'
  return null
}

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const specUrl = await resolveAnthropicSpecUrl()
  const yamlText = await fetchText(specUrl)
  const spec = parse(yamlText) as OpenApiDocument
  return {
    specs: [spec],
    sources: [{ url: specUrl, hash: await sha256Text(yamlText) }],
    outputStrategy: 'post-200',
    specRevision: specUrl,
  }
}

interface AnthropicModelList {
  data?: Array<{ id: string; display_name?: string; created_at?: string }>
  has_more?: boolean
  last_id?: string
}

async function listModels(env: ProviderSecrets): Promise<ListModelsResult> {
  const key = env.ANTHROPIC_API_KEY
  if (!key) {
    return { models: [], ...skippedResult('anthropic', 'ANTHROPIC_API_KEY') }
  }
  const headers = { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION }
  const models: ListModelsResult['models'] = []
  let afterId: string | undefined
  do {
    const url = new URL(ANTHROPIC_MODELS_URL)
    url.searchParams.set('limit', '100')
    if (afterId) url.searchParams.set('after_id', afterId)
    const body = (await fetchJson(url.toString(), {
      headers,
    })) as AnthropicModelList
    for (const m of body.data ?? []) {
      models.push({
        rawId: m.id,
        displayName: m.display_name ?? null,
        releasedAt: isoToEpochSeconds(m.created_at),
      })
    }
    afterId = body.has_more ? body.last_id : undefined
  } while (afterId)
  return { models }
}

export const anthropicProvider: ProviderConfig = {
  id: 'anthropic',
  displayName: 'Anthropic',
  authEnvVar: 'ANTHROPIC_API_KEY',
  fetchSpec,
  listModels,
  classify,
}
