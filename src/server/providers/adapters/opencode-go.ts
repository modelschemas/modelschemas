import { openCodeRouteSpec, classifyOpenCodeRoute } from '../opencode-routes.ts'
/** OpenCode Go: live ids and catalog routes. Subscription prices stay null. */
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
import { parseOpencodeModels } from './opencode.ts'

/** The models endpoint go.mdx documents. */
export const OPENCODE_GO_MODELS_URL =
  'https://opencode.ai/inference/go/v1/models'

const FETCH_TIMEOUT_MS = 30_000

async function listModels(
  _env: ProviderSecrets,
  kv?: KVNamespace,
): Promise<ListModelsResult> {
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS)
  const [payload, loaded] = await Promise.all([
    fetchJson(OPENCODE_GO_MODELS_URL, { signal }),
    loadOpenCodeCatalog(kv),
  ])
  const catalog = parseOpenCodeCatalog(
    loaded.payload,
    'opencode-go',
    loaded.hash,
  )
  const models = parseOpencodeModels(payload, 'opencode-go').map(
    (model): ModelInfo => {
      const facts = catalog[model.rawId]
      if (!facts) return { ...model, absent: { releasedAt: 'cleared' } }
      return {
        ...model,
        ...facts,
        // models.dev `cost` is left unread: it is not a confirmed billed price.
        pricing: null,
        ...(facts.releasedAt == null
          ? { absent: { releasedAt: 'cleared' } }
          : {}),
      }
    },
  )
  if (!models.some((model) => model.activity === 'chat')) {
    throw new Error('opencode-go: catalog classified 0 listed models')
  }
  return { models }
}

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const loaded = await loadOpenCodeCatalog()
  const catalog = parseOpenCodeCatalog(
    loaded.payload,
    'opencode-go',
    loaded.hash,
  )
  return openCodeRouteSpec(
    Object.values(catalog),
    { url: OPENCODE_CATALOG_URL, hash: loaded.hash },
    true,
  )
}

export const provider: ProviderConfig = {
  id: 'opencode-go',
  displayName: 'OpenCode Go',
  specSourceUrl: OPENCODE_CATALOG_URL,
  modelsEndpoint: OPENCODE_GO_MODELS_URL,
  defaultDerivation: 'docs-derived',
  bindSyncedRoutesOnly: true,
  bindStoredRoutesWithoutSchemas: true,
  fetchSpec,
  listModels,
  classify: classifyOpenCodeRoute,
}
