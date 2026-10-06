/**
 * Gemini Enterprise Agent Platform, formerly Vertex AI (issue #203).
 * The id stays `google-vertex` so stored rows and URLs keep their place.
 * Models and prices come from Google's public docs. Schemas come from
 * the public discovery document, limited to publisher model methods.
 * Partner models stay on their own providers. No service account.
 */
import type { Activity } from '#/db/schema.ts'

import { bearerConnect } from '../connect.ts'
import type { DiscoveryDoc } from '../gemini.ts'
import { fetchText, sha256Text } from '../types.ts'
import type {
  ListModelsResult,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'
import {
  VERTEX_LOCATIONS_URL,
  vertexEndpoint,
  vertexModelList,
} from '../vertex-catalog.ts'
import { VERTEX_DISCOVERY_URL, vertexOpenApi } from '../vertex-spec.ts'

const VERB_ACTIVITY: Record<string, Activity> = {
  generateContent: 'chat',
  streamGenerateContent: 'chat',
  countTokens: 'chat',
  embedContent: 'embeddings',
  predict: 'image',
  predictLongRunning: 'video',
  fetchPredictOperation: 'video',
}

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const text = await fetchText(VERTEX_DISCOVERY_URL)
  const spec = vertexOpenApi(JSON.parse(text) as DiscoveryDoc)
  return {
    specs: [spec],
    sources: [{ url: VERTEX_DISCOVERY_URL, hash: await sha256Text(text) }],
    outputStrategy: 'post-200',
  }
}

async function listModels(
  _env: ProviderSecrets,
  kv?: KVNamespace,
): Promise<ListModelsResult> {
  return { models: await vertexModelList(kv) }
}

export const provider: ProviderConfig = {
  id: 'google-vertex',
  displayName: 'Gemini Enterprise Agent Platform',
  specSourceUrl: VERTEX_DISCOVERY_URL,
  modelsEndpoint: VERTEX_LOCATIONS_URL,
  defaultDerivation: 'upstream-spec',
  connect: bearerConnect(
    'https://aiplatform.googleapis.com',
    'Global endpoint. A regional call uses https://LOCATION-aiplatform.googleapis.com with the same path.',
  ),
  fetchSpec,
  listModels,
  classify: (path): Activity | null => {
    const verb = /:([A-Za-z]+)$/.exec(path)?.[1]
    if (!verb) return null
    return VERB_ACTIVITY[verb] ?? null
  },
  generationEndpointId: ({ rawId }) => vertexEndpoint(rawId),
}
