/**
 * Vercel AI Gateway — public model list at ai-gateway.vercel.sh.
 * Prices in that payload are USD per token. Effort values are stored when
 * the row publishes them. A missing price stays null.
 */
import { compileTokenCard } from '@modelschemas/rate-card'
import type { RateCard } from '@modelschemas/rate-card'

import type { Activity } from '#/db/schema.ts'

import { fetchJson, sha256Text } from '../types.ts'
import { namespacedUpstreamIdentity } from '../upstream-model.ts'
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

/**
 * The Chat Completions field behind a toggle or budget row
 * (vercel.com/docs/ai-gateway/models-and-providers/reasoning, "How
 * reasoning is mapped"). Effort rows carry no source of their own.
 */
function controlField(reasoning: ModelReasoning | null): string | null {
  if (reasoning?.mode === 'toggle') return 'reasoning.enabled'
  return reasoning?.mode === 'budget' ? 'reasoning.max_tokens' : null
}

/**
 * The controls the gateway row lists in `reasoning_options`. An `effort`
 * entry is an effort row. Without one: `toggle` "identifies an on/off
 * control", so a row that lists it can turn reasoning off; a
 * `budget_tokens` entry alone leaves that unstated. A row with a control
 * type this does not know stores nothing.
 */
export function vercelReasoning(
  row: Record<string, unknown>,
): ModelReasoning | null {
  const options = Array.isArray(row.reasoning_options)
    ? row.reasoning_options.filter(isRecord)
    : []
  const toggle = options.some((option) => option.type === 'toggle')
  const effort = options.find((option) => option.type === 'effort')
  const efforts = effort ? stringList(effort.values) : null
  if (efforts) {
    return {
      mode: 'effort',
      mandatory:
        !toggle && !efforts.includes('none') && !efforts.includes('off'),
      efforts,
    }
  }
  const types = options.map((option) => option.type)
  if (types.some((type) => type !== 'toggle' && type !== 'budget_tokens')) {
    return null
  }
  if (types.includes('budget_tokens')) {
    return { mode: 'budget', mandatory: toggle ? false : null }
  }
  return toggle ? { mode: 'toggle', mandatory: false } : null
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
    const reasoning = vercelReasoning(row)
    const field = controlField(reasoning)
    models.push({
      rawId: row.id,
      displayName: typeof row.name === 'string' ? row.name : null,
      activity,
      contextWindow: positive(row.context_window),
      maxOutput: positive(row.max_tokens),
      modalities: modalities(row.modalities),
      pricing: card,
      reasoning,
      releasedAt: positive(row.released),
      ...(field
        ? {
            factSources: {
              reasoning: {
                derivation: 'listing',
                sourceUrl: source.url,
                sourceHash: source.hash,
                path: field,
              },
            },
          }
        : {}),
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
  upstreamModelIdentity: (rawId) =>
    namespacedUpstreamIdentity(rawId, {
      derivation: 'listing',
      sourceUrl: VERCEL_MODELS_URL,
      path: 'data[].id',
    }),
  displayName: 'Vercel AI Gateway',
  specSourceUrl: 'https://vercel.com/docs/ai-gateway',
  modelsEndpoint: VERCEL_MODELS_URL,
  defaultDerivation: 'docs-derived',
  fetchSpec,
  listModels,
  classify: () => null,
}
