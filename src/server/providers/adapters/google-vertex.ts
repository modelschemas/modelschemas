/**
 * Google Vertex AI — listModels and fetchSpec skip.
 * fetched Vertex docs do not include publisher model ids, and the list API requires a service account.
 * An empty model list would mark stored rows removed, so this returns skipped.
 */
import type {
  ListModelsResult,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

export const SKIP_REASON =
  'google-vertex: fetched Vertex docs do not include publisher model ids, and the list API requires a service account — skipped'

function skippedSpec(): SpecFetchResult {
  return {
    specs: [],
    sources: [],
    outputStrategy: 'post-200',
    skipped: SKIP_REASON,
  }
}

function skippedModels(): ListModelsResult {
  return { models: [], skipped: SKIP_REASON }
}

export const provider: ProviderConfig = {
  id: 'google-vertex',
  displayName: 'Google Vertex AI',
  specSourceUrl: 'https://cloud.google.com/vertex-ai/generative-ai/docs/models',
  defaultDerivation: 'docs-derived',
  fetchSpec: (_env: ProviderSecrets) => Promise.resolve(skippedSpec()),
  listModels: (_env: ProviderSecrets) => Promise.resolve(skippedModels()),
  classify: () => null,
}
