import { openCodeRouteSpec, classifyOpenCodeRoute } from '../opencode-routes.ts'
/** OpenCode Zen: live ids, with routes and prices from OpenCode's models.dev catalog. */
import {
  loadOpenCodeCatalog,
  OPENCODE_CATALOG_URL,
  parseOpenCodeCatalog,
} from '../opencode-catalog.ts'
import { fetchJson } from '../types.ts'
import type {
  ListModelsResult,
  ModelInfo,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

export const OPENCODE_MODELS_URL = 'https://opencode.ai/inference/v1/models'

const FETCH_TIMEOUT_MS = 30_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseOpencodeModels(
  payload: unknown,
  tag = 'opencode',
): Array<ModelInfo> {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error(`${tag}: models payload has no data array`)
  }
  const models: Array<ModelInfo> = []
  for (const row of payload.data) {
    if (!isRecord(row) || typeof row.id !== 'string' || row.id.length === 0) {
      continue
    }
    models.push({
      rawId: row.id,
      releasedAt: null,
      pricing: null,
    })
  }
  if (models.length === 0) {
    throw new Error(`${tag}: models payload listed no ids`)
  }
  return models
}

function withCatalog(
  listed: Array<ModelInfo>,
  catalog: Record<string, ModelInfo>,
): Array<ModelInfo> {
  return listed.map((model): ModelInfo => {
    const facts = catalog[model.rawId]
    if (!facts) return { ...model, absent: { releasedAt: 'cleared' } }
    return {
      ...model,
      ...facts,
      ...(facts.releasedAt == null
        ? { absent: { releasedAt: 'cleared' } }
        : {}),
    }
  })
}

async function listModels(
  _env: ProviderSecrets,
  kv?: KVNamespace,
): Promise<ListModelsResult> {
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS)
  const [payload, loaded] = await Promise.all([
    fetchJson(OPENCODE_MODELS_URL, { signal }),
    loadOpenCodeCatalog(kv),
  ])
  const catalog = parseOpenCodeCatalog(
    loaded.payload,
    'opencode',
    loaded.hash,
    loaded.extractedAt,
  )
  const models = withCatalog(parseOpencodeModels(payload), catalog)
  if (!models.some((model) => model.pricing)) {
    throw new Error('opencode: catalog priced 0 listed models')
  }
  return { models }
}

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const loaded = await loadOpenCodeCatalog()
  const catalog = parseOpenCodeCatalog(
    loaded.payload,
    'opencode',
    loaded.hash,
    loaded.extractedAt,
  )
  return openCodeRouteSpec(
    Object.values(catalog),
    { url: OPENCODE_CATALOG_URL, hash: loaded.hash },
    false,
  )
}

// No `upstreamModelIdentity`, here or for OpenCode Go: OpenCode names no
// maker. `owned_by` is `opencode` on every row, and the catalog's AI SDK
// package names the wire protocol: `@ai-sdk/anthropic` also serves the Qwen
// rows, `@ai-sdk/openai` the Grok and Muse Spark rows.
export const provider: ProviderConfig = {
  id: 'opencode',
  displayName: 'OpenCode Zen',
  specSourceUrl: OPENCODE_CATALOG_URL,
  modelsEndpoint: OPENCODE_MODELS_URL,
  defaultDerivation: 'docs-derived',
  bindSyncedRoutesOnly: true,
  bindStoredRoutesWithoutSchemas: true,
  fetchSpec,
  listModels,
  classify: classifyOpenCodeRoute,
}
