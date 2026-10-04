/**
 * Hugging Face Inference Providers — the public router model list.
 * Architecture modalities are Hugging Face's. Prices on `providers[]` belong
 * to other hosts, so this catalog leaves pricing null.
 */
import type { Activity } from '#/db/schema.ts'

import { fetchJson } from '../types.ts'
import type {
  ListModelsResult,
  ModelInfo,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

export const HUGGINGFACE_MODELS_URL = 'https://router.huggingface.co/v1/models'

const SPEC_SKIP = 'huggingface: no first-party OpenAPI document — skipped'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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

function activityFor(output: Array<string> | null): Activity | null {
  if (!output) return null
  if (output.includes('image') && !output.includes('text')) return 'image'
  if (output.includes('text')) return 'chat'
  if (output.includes('embedding') || output.includes('embeddings')) {
    return 'embeddings'
  }
  if (output.includes('audio')) return 'audio'
  return null
}

export function parseHuggingFaceModels(payload: unknown): Array<ModelInfo> {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error('huggingface: models payload has no data array')
  }
  const models: Array<ModelInfo> = []
  for (const row of payload.data) {
    if (!isRecord(row) || typeof row.id !== 'string' || row.id.length === 0) {
      continue
    }
    const architecture = isRecord(row.architecture) ? row.architecture : null
    const input = architecture
      ? stringList(architecture.input_modalities)
      : null
    const output = architecture
      ? stringList(architecture.output_modalities)
      : null
    models.push({
      rawId: row.id,
      activity: activityFor(output),
      modalities: input && output ? { input, output } : null,
      pricing: null,
      releasedAt:
        typeof row.created === 'number' && row.created > 0 ? row.created : null,
    })
  }
  if (models.length === 0) {
    throw new Error('huggingface: models payload listed no ids')
  }
  return models
}

async function listModels(_env: ProviderSecrets): Promise<ListModelsResult> {
  const payload = await fetchJson(HUGGINGFACE_MODELS_URL)
  return { models: parseHuggingFaceModels(payload) }
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
  id: 'huggingface',
  displayName: 'Hugging Face',
  specSourceUrl: 'https://huggingface.co/docs/inference-providers',
  modelsEndpoint: HUGGINGFACE_MODELS_URL,
  defaultDerivation: 'docs-derived',
  fetchSpec,
  listModels,
  classify: () => null,
}
