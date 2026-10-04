/**
 * OpenCode Zen — ids from the provider's public models list.
 * That payload publishes id and created. It does not publish prices,
 * modalities, or reasoning, so those stay null.
 */
import { fetchJson } from '../types.ts'
import type {
  ListModelsResult,
  ModelInfo,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

export const OPENCODE_MODELS_URL = 'https://opencode.ai/zen/v1/models'

const SPEC_SKIP = 'opencode: no first-party OpenAPI document — skipped'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseOpencodeModels(payload: unknown): Array<ModelInfo> {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error('opencode: models payload has no data array')
  }
  const models: Array<ModelInfo> = []
  for (const row of payload.data) {
    if (!isRecord(row) || typeof row.id !== 'string' || row.id.length === 0) {
      continue
    }
    models.push({
      rawId: row.id,
      releasedAt:
        typeof row.created === 'number' && row.created > 0 ? row.created : null,
      pricing: null,
    })
  }
  if (models.length === 0) {
    throw new Error('opencode: models payload listed no ids')
  }
  return models
}

async function listModels(_env: ProviderSecrets): Promise<ListModelsResult> {
  const payload = await fetchJson(OPENCODE_MODELS_URL)
  return { models: parseOpencodeModels(payload) }
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
  id: 'opencode',
  displayName: 'OpenCode Zen',
  specSourceUrl: 'https://opencode.ai/docs/zen',
  modelsEndpoint: OPENCODE_MODELS_URL,
  defaultDerivation: 'docs-derived',
  fetchSpec,
  listModels,
  classify: () => null,
}
