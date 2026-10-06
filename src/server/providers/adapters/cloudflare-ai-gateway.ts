/**
 * Cloudflare AI Gateway — listModels and fetchSpec skip.
 * Cloudflare AI Gateway docs do not publish a model catalog.
 * An empty model list would mark stored rows removed, so this returns skipped.
 */
import { namespacedUpstreamIdentity } from '../upstream-model.ts'
import type {
  ListModelsResult,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

export const SKIP_REASON =
  'cloudflare-ai-gateway: Cloudflare AI Gateway docs do not publish a model catalog — skipped'

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
  id: 'cloudflare-ai-gateway',
  upstreamModelIdentity: (rawId) =>
    namespacedUpstreamIdentity(rawId, {
      derivation: 'docs-derived',
      sourceUrl:
        'https://developers.cloudflare.com/ai-gateway/usage/chat-completion/',
      path: 'provider/model identifier',
    }),
  displayName: 'Cloudflare AI Gateway',
  specSourceUrl: 'https://developers.cloudflare.com/ai-gateway/',
  defaultDerivation: 'docs-derived',
  fetchSpec: (_env: ProviderSecrets) => Promise.resolve(skippedSpec()),
  listModels: (_env: ProviderSecrets) => Promise.resolve(skippedModels()),
  classify: () => null,
}
