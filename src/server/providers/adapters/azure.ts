/**
 * Azure OpenAI — model ids from Microsoft's public models article.
 * That page names ids in `<code>` and does not name dollar amounts, so
 * prices stay null. Deployment lists on a resource need a key and are not called.
 */
import type { Activity } from '#/db/schema.ts'

import { fetchText } from '../types.ts'
import type {
  ListModelsResult,
  ModelInfo,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

export const AZURE_MODELS_URL =
  'https://learn.microsoft.com/en-us/azure/ai-services/openai/concepts/models'

const SPEC_SKIP = 'azure: no first-party OpenAPI document — skipped'

/** Ids the models article puts in code tags. Request fields are not ids. */
const MODEL_ID =
  /^(?:gpt-|o\d|dall-e-|whisper-|tts-|text-embedding-|sora-|codex-|computer-use-|gpt-image-)/

export function parseAzureModelIds(html: string): Array<ModelInfo> {
  const ids = new Set<string>()
  for (const match of html.matchAll(/<code>([^<]+)<\/code>/g)) {
    const id = match[1]?.trim() ?? ''
    if (MODEL_ID.test(id)) ids.add(id)
  }
  if (ids.size === 0) {
    throw new Error('azure: models page listed no ids')
  }
  return [...ids].map((rawId) => ({ rawId, pricing: null }))
}

async function listModels(_env: ProviderSecrets): Promise<ListModelsResult> {
  const html = await fetchText(AZURE_MODELS_URL)
  return { models: parseAzureModelIds(html) }
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
  id: 'azure',
  upstreamModelIdentity: (rawId) => ({
    providerNamespace: 'openai',
    rawId,
    source: {
      derivation: 'docs-derived',
      sourceUrl: AZURE_MODELS_URL,
      path: 'model id',
    },
  }),
  displayName: 'Azure OpenAI',
  specSourceUrl: AZURE_MODELS_URL,
  modelsEndpoint: AZURE_MODELS_URL,
  defaultDerivation: 'docs-derived',
  fetchSpec,
  listModels,
  classify: (_path: string): Activity | null => null,
}
