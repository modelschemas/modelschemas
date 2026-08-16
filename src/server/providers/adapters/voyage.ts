/**
 * Voyage AI — official OpenAPI spec from github.com/voyage-ai/openapi
 * (`voyage-openapi.yml`; the hinted `openapi.yaml` 404s). Embeddings only;
 * rerank is not in our activity enum. There is no `/v1/models` list
 * (that URL 404s); the catalog is the model names the spec documents.
 */
import type { Activity } from '#/db/schema.ts'
import { fetchOpenApi } from '../types.ts'
import type {
  ListModelsResult,
  ModelInfo,
  OpenApiDocument,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

const VOYAGE_OPENAPI_URL =
  'https://raw.githubusercontent.com/voyage-ai/openapi/main/voyage-openapi.yml'

const DOCUMENTED_MODEL = /`((?:voyage|rerank)-[a-z0-9.-]+)`/g

/**
 * Path rules — the published spec (and docs) sit under server
 * `https://api.voyageai.com/v1`, so classify sees `/embeddings` etc. Also
 * accept a `/v1/` prefix. Text, multimodal, and contextualized embedding
 * POSTs are generation; rerank, models, and batch/admin are platform.
 */
function classify(path: string): Activity | null {
  const bare = path.startsWith('/v1/') ? path.slice(3) : path
  if (
    bare === '/embeddings' ||
    bare === '/multimodalembeddings' ||
    bare === '/contextualizedembeddings'
  ) {
    return 'embeddings'
  }
  return null
}

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const { spec, hash } = await fetchOpenApi(VOYAGE_OPENAPI_URL)
  return {
    specs: [spec],
    sources: [{ url: VOYAGE_OPENAPI_URL, hash }],
    outputStrategy: 'post-200',
  }
}

/** Model ids Voyage documents in descriptions (and any real enums). */
export function voyageModelsFromSpec(spec: OpenApiDocument): Array<ModelInfo> {
  const ids = new Set<string>()
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) visit(item)
      return
    }
    const rec = node as Record<string, unknown>
    if (typeof rec.description === 'string') {
      for (const match of rec.description.matchAll(DOCUMENTED_MODEL)) {
        const id = match[1]
        if (id !== undefined) ids.add(id)
      }
    }
    if (Array.isArray(rec.enum)) {
      for (const value of rec.enum) {
        if (typeof value === 'string' && /^(?:voyage|rerank)-/.test(value)) {
          ids.add(value)
        }
      }
    }
    for (const value of Object.values(rec)) visit(value)
  }
  visit(spec)
  return [...ids]
    .filter((id) => id.startsWith('voyage-'))
    .sort()
    .map((rawId) => ({ rawId, activity: 'embeddings' as const }))
}

async function listModels(_env: ProviderSecrets): Promise<ListModelsResult> {
  const { spec } = await fetchOpenApi(VOYAGE_OPENAPI_URL)
  return { models: voyageModelsFromSpec(spec) }
}

export const provider: ProviderConfig = {
  id: 'voyage',
  displayName: 'Voyage AI',
  authEnvVar: 'VOYAGE_API_KEY',
  specSourceUrl: VOYAGE_OPENAPI_URL,
  modelsEndpoint: VOYAGE_OPENAPI_URL,
  defaultDerivation: 'upstream-spec',
  fetchSpec,
  listModels,
  classify,
}
