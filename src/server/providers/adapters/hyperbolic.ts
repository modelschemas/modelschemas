/**
 * Hyperbolic — OpenAI-compatible inference API. No public spec; schemas
 * are generated from the canonical OpenAI document.
 */
import { hyperbolicListingCard } from '../catalog-prices.ts'
import {
  classifyOpenAiCompat,
  fetchOpenAiCompatibleSpec,
  listOpenAiCompatibleModels,
  openAiCompatModelFacts,
} from '../openai-compat.ts'
import type { OpenAiCompatModelRow } from '../openai-compat.ts'
import {
  compatGenerationEndpointId,
  flaggedChatModalities,
  hyperbolicModelActivity,
} from '../model-meta.ts'
import type {
  ModelInfo,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

const HYPERBOLIC_DOCS_URL = 'https://docs.hyperbolic.xyz'
const HYPERBOLIC_MODELS_URL = 'https://api.hyperbolic.xyz/v1/models'
const HYPERBOLIC_SERVER_URL = 'https://api.hyperbolic.xyz/v1'

/**
 * `supports_tools` is the only capability the models list states. A false
 * flag is an empty list, not an unknown one. Other row flags (features,
 * sampling) still count; the boolean wins for `tools`.
 */
function hyperbolicCapabilities(
  row: OpenAiCompatModelRow,
): Pick<ModelInfo, 'capabilities' | 'exactCapabilities' | 'factSources'> {
  if (typeof row.supports_tools !== 'boolean') return {}
  const listed = openAiCompatModelFacts(row).capabilities
  const caps = new Set(Array.isArray(listed) ? listed : [])
  if (row.supports_tools) caps.add('tools')
  else caps.delete('tools')
  const capabilities = [...caps]
  return {
    capabilities,
    exactCapabilities: true,
    ...(capabilities.includes('tools')
      ? {
          factSources: {
            capabilities: {
              tools: {
                derivation: 'listing',
                sourceUrl: HYPERBOLIC_MODELS_URL,
                path: 'supports_tools',
              },
            },
          },
        }
      : {}),
  }
}

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const { spec, url, hash } = await fetchOpenAiCompatibleSpec({
    title: 'Hyperbolic',
    serverUrl: HYPERBOLIC_SERVER_URL,
    include: ['/chat/completions'],
  })
  return {
    specs: [spec],
    sources: [{ url, hash }],
    outputStrategy: 'post-200',
  }
}

export const provider: ProviderConfig = {
  id: 'hyperbolic',
  displayName: 'Hyperbolic',
  authEnvVar: 'HYPERBOLIC_API_KEY',
  specSourceUrl: HYPERBOLIC_DOCS_URL,
  modelsEndpoint: HYPERBOLIC_MODELS_URL,
  defaultDerivation: 'generated',
  fetchSpec,
  listModels: (env) =>
    listOpenAiCompatibleModels({
      providerId: 'hyperbolic',
      url: HYPERBOLIC_MODELS_URL,
      env,
      envVar: 'HYPERBOLIC_API_KEY',
      activity: hyperbolicModelActivity,
      extend: async (row) => {
        const pricing = await hyperbolicListingCard(
          row.input_price,
          row.output_price,
          HYPERBOLIC_MODELS_URL,
        )
        return {
          ...(row.supports_chat !== undefined
            ? { modalities: flaggedChatModalities(row) }
            : {}),
          ...(pricing ? { pricing } : {}),
          ...hyperbolicCapabilities(row),
        }
      },
    }),
  classify: classifyOpenAiCompat,
  generationEndpointId: ({ activity }) => compatGenerationEndpointId(activity),
}
