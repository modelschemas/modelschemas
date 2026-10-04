/**
 * Vercel AI Gateway — public model list at ai-gateway.vercel.sh.
 * Prices in that payload are USD per token. Effort values are stored when
 * the row publishes them. A missing price stays null.
 */
import { compileTokenCard } from '@modelschemas/rate-card'
import type { RateCard } from '@modelschemas/rate-card'

import type { Activity } from '#/db/schema.ts'

import { fetchJson, sha256Text } from '../types.ts'
import type {
  ListModelsResult,
  ModelInfo,
  ModelReasoning,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

export const VERCEL_MODELS_URL = 'https://ai-gateway.vercel.sh/v1/models'

const SPEC_SKIP = 'vercel: no first-party OpenAPI document — skipped'

const TYPE_ACTIVITY: Record<string, Activity> = {
  language: 'chat',
  embedding: 'embeddings',
  image: 'image',
  video: 'video',
  speech: 'audio',
  transcription: 'audio',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : null
}

function stringList(value: unknown): Array<string> | null {
  if (!Array.isArray(value) || value.length === 0) return null
  const out: Array<string> = []
  for (const item of value) {
    if (typeof item !== 'string') return null
    out.push(item)
  }
  return out
}

function perToken(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value
  }
  if (typeof value !== 'string' || value.length === 0) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function modalities(value: unknown): ModelInfo['modalities'] {
  if (!isRecord(value)) return null
  const input = stringList(value.input)
  const output = stringList(value.output)
  if (!input || !output) return null
  return { input, output }
}

/** Effort control published on the gateway row. Toggle-only rows stay null. */
export function vercelReasoning(
  row: Record<string, unknown>,
): ModelReasoning | null {
  const options = Array.isArray(row.reasoning_options)
    ? row.reasoning_options.filter(isRecord)
    : []
  const effort = options.find((option) => option.type === 'effort')
  const efforts = effort ? stringList(effort.values) : null
  if (!efforts) return null
  const toggle = options.some((option) => option.type === 'toggle')
  return {
    mode: 'effort',
    mandatory: !toggle && !efforts.includes('none') && !efforts.includes('off'),
    efforts,
  }
}

export function parseVercelModels(
  payload: unknown,
  source: RateCard['source'],
): Array<ModelInfo> {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error('vercel: models payload has no data array')
  }
  const models: Array<ModelInfo> = []
  for (const row of payload.data) {
    if (!isRecord(row) || typeof row.id !== 'string' || row.id.length === 0) {
      continue
    }
    const pricing = isRecord(row.pricing) ? row.pricing : null
    const input = pricing ? perToken(pricing.input) : null
    const output = pricing ? perToken(pricing.output) : null
    const card =
      input !== null && output !== null
        ? compileTokenCard(
            { input_tokens: input, output_tokens: output },
            [],
            source,
          )
        : null
    const activity =
      typeof row.type === 'string' ? (TYPE_ACTIVITY[row.type] ?? null) : null
    models.push({
      rawId: row.id,
      displayName: typeof row.name === 'string' ? row.name : null,
      activity,
      contextWindow: positive(row.context_window),
      maxOutput: positive(row.max_tokens),
      modalities: modalities(row.modalities),
      pricing: card,
      reasoning: vercelReasoning(row),
      releasedAt: positive(row.released),
    })
  }
  if (models.length === 0) {
    throw new Error('vercel: models payload listed no ids')
  }
  return models
}

async function listModels(_env: ProviderSecrets): Promise<ListModelsResult> {
  const payload = await fetchJson(VERCEL_MODELS_URL)
  const text = JSON.stringify(payload)
  return {
    models: parseVercelModels(payload, {
      url: VERCEL_MODELS_URL,
      hash: await sha256Text(text),
      extractedAt: new Date().toISOString(),
    }),
  }
}

function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  return Promise.resolve({
    specs: [],
    sources: [],
    outputStrategy: 'post-200',
    skipped: SPEC_SKIP,
  })
}

export const provider: ProviderConfig = {
  id: 'vercel',
  displayName: 'Vercel AI Gateway',
  specSourceUrl: 'https://vercel.com/docs/ai-gateway',
  modelsEndpoint: VERCEL_MODELS_URL,
  defaultDerivation: 'docs-derived',
  fetchSpec,
  listModels,
  classify: () => null,
}
