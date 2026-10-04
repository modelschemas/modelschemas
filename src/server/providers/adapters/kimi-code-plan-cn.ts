/**
 * Kimi For Coding (China) — listModels and fetchSpec skip.
 * the Kimi Code models page is a client shell and does not include model ids.
 * An empty model list would mark stored rows removed, so this returns skipped.
 */
import type {
  ListModelsResult,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

export const SKIP_REASON =
  'kimi-code-plan-cn: the Kimi Code models page is a client shell and does not include model ids — skipped'

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
  id: 'kimi-code-plan-cn',
  displayName: 'Kimi For Coding (China)',
  specSourceUrl: 'https://www.kimi.com/code/docs/en/kimi-code/models.html',
  defaultDerivation: 'docs-derived',
  fetchSpec: (_env: ProviderSecrets) => Promise.resolve(skippedSpec()),
  listModels: (_env: ProviderSecrets) => Promise.resolve(skippedModels()),
  classify: () => null,
}
