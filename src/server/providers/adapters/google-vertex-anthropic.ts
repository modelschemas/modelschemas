/**
 * Google-hosted Claude: dynamically read Google's linked model cards and prices.
 */
import type {
  ListModelsResult,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'
import { fetchText, sha256Text } from '../types.ts'
import {
  VERTEX_CLAUDE_URL,
  VERTEX_CLAUDE_REQUEST_URL,
  vertexClaudeModels,
} from '../vertex-claude.ts'

export const SKIP_REASON =
  'google-vertex-anthropic: Google publishes request examples, not a machine-readable Claude body schema — skipped'

async function skippedSpec(): Promise<SpecFetchResult> {
  const text = await fetchText(VERTEX_CLAUDE_REQUEST_URL)
  if (!text.includes(':rawPredict') || !text.includes('anthropic_version')) {
    throw new Error('vertex claude: request documentation changed')
  }
  return {
    specs: [],
    sources: [{ url: VERTEX_CLAUDE_REQUEST_URL, hash: await sha256Text(text) }],
    outputStrategy: 'post-200',
    skipped: SKIP_REASON,
  }
}

export const provider: ProviderConfig = {
  id: 'google-vertex-anthropic',
  displayName: 'Vertex (Anthropic)',
  specSourceUrl: VERTEX_CLAUDE_REQUEST_URL,
  modelsEndpoint: VERTEX_CLAUDE_URL,
  defaultDerivation: 'docs-derived',
  fetchSpec: (_env: ProviderSecrets) => skippedSpec(),
  listModels: async (
    _env: ProviderSecrets,
    kv?: KVNamespace,
  ): Promise<ListModelsResult> => ({ models: await vertexClaudeModels(kv) }),
  bindSyncedRoutesOnly: true,
  classify: () => null,
}
