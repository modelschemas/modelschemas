/**
 * Amazon Bedrock — listModels and fetchSpec skip.
 * public docs list marketing names, not API model ids, and ListFoundationModels requires AWS credentials.
 * An empty model list would mark stored rows removed, so this returns skipped.
 */
import type {
  ListModelsResult,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

export const SKIP_REASON =
  'amazon-bedrock: public docs list marketing names, not API model ids, and ListFoundationModels requires AWS credentials — skipped'

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
  id: 'amazon-bedrock',
  displayName: 'Amazon Bedrock',
  specSourceUrl:
    'https://docs.aws.amazon.com/bedrock/latest/userguide/models-supported.html',
  defaultDerivation: 'docs-derived',
  fetchSpec: (_env: ProviderSecrets) => Promise.resolve(skippedSpec()),
  listModels: (_env: ProviderSecrets) => Promise.resolve(skippedModels()),
  classify: () => null,
}
