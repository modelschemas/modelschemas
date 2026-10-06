/**
 * OpenCode Go — ids from the provider's public models list, activity from
 * its docs page.
 *
 * The list publishes ids only (`created` is the request time). The docs
 * page's Endpoints table names each model's route, which classifies the
 * row. The route is not stored: no OpenAPI document exists for
 * `schemaEndpointId` to bind to.
 *
 * Prices stay null. Go is billed per month ($10 Go, $40 Go Plus); the
 * page's "Usage limits" table quotes per-1M-token rates only to say how
 * usage counts toward each plan's monthly dollar limit, so nobody is
 * billed them. Context window, output cap, modalities, capabilities, and
 * reasoning are published nowhere (docs/source-silent/opencode-go.md).
 */
import type { Activity } from '#/db/schema.ts'

import { cachedDocs } from '../model-facts.ts'
import { fetchJson, fetchText } from '../types.ts'
import type {
  ListModelsResult,
  ModelInfo,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'
import { parseDocsEndpoints } from './opencode.ts'

export const OPENCODE_GO_MODELS_URL = 'https://opencode.ai/zen/go/v1/models'

/** Page readers see; the facts are parsed from its markdown twin. */
export const OPENCODE_GO_DOCS_URL = 'https://opencode.ai/docs/go'

export const OPENCODE_GO_DOCS_MARKDOWN = `${OPENCODE_GO_DOCS_URL}.md`

const SPEC_SKIP = 'opencode-go: no first-party OpenAPI document — skipped'

const FETCH_TIMEOUT_MS = 30_000

export interface GoDocsModel {
  displayName: string
  activity: Activity | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Endpoints table of the Go docs page, keyed by model id. */
export function parseGoDocs(markdown: string): Record<string, GoDocsModel> {
  const byId: Record<string, GoDocsModel> = {}
  let chat = 0
  for (const { id, displayName, activity } of parseDocsEndpoints(
    markdown,
    'opencode-go',
    'https://opencode.ai/zen/go/',
  )) {
    if (activity === 'chat') chat += 1
    byId[id] = { displayName, activity }
  }
  if (chat === 0) throw new Error('opencode-go: docs classified 0 model rows')
  return byId
}

export function parseOpencodeGoModels(payload: unknown): Array<ModelInfo> {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error('opencode-go: models payload has no data array')
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
    throw new Error('opencode-go: models payload listed no ids')
  }
  return models
}

async function listModels(
  _env: ProviderSecrets,
  kv?: KVNamespace,
): Promise<ListModelsResult> {
  const signal = () => AbortSignal.timeout(FETCH_TIMEOUT_MS)
  const payload = await fetchJson(OPENCODE_GO_MODELS_URL, { signal: signal() })
  const byId = await cachedDocs(kv, OPENCODE_GO_DOCS_MARKDOWN, async () =>
    parseGoDocs(
      await fetchText(OPENCODE_GO_DOCS_MARKDOWN, { signal: signal() }),
    ),
  )
  const models = parseOpencodeGoModels(payload).map((model): ModelInfo => {
    const row = byId[model.rawId]
    return row ? { ...model, ...row } : model
  })
  return { models }
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
  id: 'opencode-go',
  displayName: 'OpenCode Go',
  specSourceUrl: OPENCODE_GO_DOCS_URL,
  modelsEndpoint: OPENCODE_GO_MODELS_URL,
  defaultDerivation: 'docs-derived',
  fetchSpec,
  listModels,
  classify: () => null,
}
