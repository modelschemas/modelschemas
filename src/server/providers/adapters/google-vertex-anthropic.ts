/**
 * Vertex (Anthropic) — listModels and fetchSpec skip.
 * the fetched partner Claude page does not include Claude model ids.
 * An empty model list would mark stored rows removed, so this returns skipped.
 */
import type {
  ListModelsResult,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

export const SKIP_REASON =
  'google-vertex-anthropic: the fetched partner Claude page does not include Claude model ids — skipped'

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
  id: 'google-vertex-anthropic',
  displayName: 'Vertex (Anthropic)',
  specSourceUrl:
    'https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/claude',
  defaultDerivation: 'docs-derived',
  fetchSpec: (_env: ProviderSecrets) => Promise.resolve(skippedSpec()),
  listModels: (_env: ProviderSecrets) => Promise.resolve(skippedModels()),
  classify: () => null,
}
