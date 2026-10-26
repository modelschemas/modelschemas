import { bearerConnect } from '../connect.ts'
import { docsReport, docsRun, tryDocs } from '../model-facts.ts'
import {
  OPENCODE_GO_DOCS_URL,
  OPENCODE_GO_REQUIRED_HEADERS,
  parseGoTraining,
} from '../opencode-go-facts.ts'
import {
  OPENCODE_GO_ROUTE_DOCS_URL,
  classifyOpenCodeRoute,
  openCodeRouteSpec,
} from '../opencode-routes.ts'
/** OpenCode Go: live ids and catalog routes. Subscription prices stay null. */
import {
  loadOpenCodeCatalog,
  OPENCODE_CATALOG_URL,
  parseOpenCodeCatalog,
} from '../opencode-catalog.ts'
import { fetchJson, fetchText, sha256Text } from '../types.ts'
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
  const docs = docsRun()
  const [payload, loaded, privacy] = await Promise.all([
    fetchJson(OPENCODE_GO_MODELS_URL, { signal }),
    loadOpenCodeCatalog(kv),
    tryDocs(docs, OPENCODE_GO_ROUTE_DOCS_URL, async (cached) => {
      const doc = await cached(kv, OPENCODE_GO_ROUTE_DOCS_URL, async () => {
        const text = await fetchText(OPENCODE_GO_ROUTE_DOCS_URL, {
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        })
        return { text, hash: await sha256Text(text) }
      })
      return { training: parseGoTraining(doc.text), hash: doc.hash }
    }),
  ])
  const catalog = parseOpenCodeCatalog(
    loaded.payload,
    'opencode-go',
    loaded.hash,
  )
  const models = parseOpencodeModels(payload, 'opencode-go').map(
    (model): ModelInfo => {
      const facts = catalog[model.rawId]
      const stated = privacy?.training.get(model.rawId)
      const trainsOnRequestData = stated === true ? true : null
      const factSources =
        stated === true
          ? {
              ...facts?.factSources,
              trainsOnRequestData: {
                derivation: 'docs-derived' as const,
                sourceUrl: OPENCODE_GO_DOCS_URL,
                sourceHash: privacy?.hash,
                path: 'Privacy',
              },
            }
          : facts?.factSources
      const absent = {
        ...(facts?.releasedAt == null
          ? { releasedAt: 'cleared' as const }
          : {}),
        ...(privacy ? {} : { trainsOnRequestData: 'unavailable' as const }),
      }
      if (!facts) {
        return {
          ...model,
          trainsOnRequestData,
          ...(factSources ? { factSources } : {}),
          absent,
        }
      }
      return {
        ...model,
        ...facts,
        trainsOnRequestData,
        // models.dev `cost` is left unread: it is not a confirmed billed price.
        pricing: null,
        ...(factSources ? { factSources } : {}),
        ...(Object.keys(absent).length > 0 ? { absent } : {}),
      }
    },
  )
  if (!models.some((model) => model.activity === 'chat')) {
    throw new Error('opencode-go: catalog classified 0 listed models')
  }
  return { models, docsFailures: docsReport(docs) }
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
  connect: {
    ...bearerConnect('https://opencode.ai', 'OpenCode Go'),
    requiredHeaders: OPENCODE_GO_REQUIRED_HEADERS,
  },
  fetchSpec,
  listModels,
  classify: classifyOpenCodeRoute,
}
