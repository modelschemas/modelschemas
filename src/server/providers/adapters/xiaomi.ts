/**
 * Xiaomi — listModels and fetchSpec skip.
 * the Xiaomi model list requires an API key and the docs shell does not include API model ids.
 * An empty model list would mark stored rows removed, so this returns skipped.
 */
import type {
  ListModelsResult,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

export const SKIP_REASON =
  'xiaomi: the Xiaomi model list requires an API key and the docs shell does not include API model ids — skipped'

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
  id: 'xiaomi',
  displayName: 'Xiaomi',
  specSourceUrl: 'https://platform.xiaomimimo.com/#/docs',
  defaultDerivation: 'docs-derived',
  fetchSpec: (_env: ProviderSecrets) => Promise.resolve(skippedSpec()),
  listModels: (_env: ProviderSecrets) => Promise.resolve(skippedModels()),
  classify: () => null,
}
