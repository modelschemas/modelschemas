/**
 * DeepSeek — OpenAI-compatible chat API. No published OpenAPI document;
 * schemas are generated from the canonical OpenAI spec. Official host is
 * https://api.deepseek.com (POST /chat/completions, no /v1 prefix).
 */
import {
  applyReplay,
  deepseekEffortFacts,
  DEEPSEEK_THINKING_URL,
  loadReplayDoc,
  parseDeepseekReplay,
} from '../provider-replay.ts'
import { deepseekModelPricing } from '../deepseek-pricing.ts'
import {
  classifyOpenAiCompat,
  fetchOpenAiCompatibleSpec,
  listOpenAiCompatibleModels,
  openAiCompatModelFacts,
  OPENAI_OPENAPI_URL,
} from '../openai-compat.ts'
import {
  compatGenerationEndpointId,
  deepseekModelActivity,
} from '../model-meta.ts'
import type {
  ListModelsResult,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

const DEEPSEEK_SERVER_URL = 'https://api.deepseek.com'
const DEEPSEEK_MODELS_URL = 'https://api.deepseek.com/models'

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const { spec, url, hash } = await fetchOpenAiCompatibleSpec({
    title: 'DeepSeek',
    serverUrl: DEEPSEEK_SERVER_URL,
    include: ['/chat/completions'],
  })
  return {
    specs: [spec],
    sources: [{ url, hash }],
    outputStrategy: 'post-200',
  }
}

export const provider: ProviderConfig = {
  id: 'deepseek',
  displayName: 'DeepSeek',
  authEnvVar: 'DEEPSEEK_API_KEY',
  specSourceUrl: OPENAI_OPENAPI_URL,
  modelsEndpoint: DEEPSEEK_MODELS_URL,
  defaultDerivation: 'generated',
  fetchSpec,
  listModels: async (env, kv): Promise<ListModelsResult> => {
    const listed = await listOpenAiCompatibleModels({
      providerId: 'deepseek',
      url: DEEPSEEK_MODELS_URL,
      env,
      envVar: 'DEEPSEEK_API_KEY',
      activity: deepseekModelActivity,
      extend: async (row) => {
        const hit = deepseekEffortFacts(row.effort)
        if (!hit) return {}
        const capabilities = openAiCompatModelFacts(row).capabilities
        return {
          reasoning: hit.reasoning,
          capabilities: [
            ...new Set([
              ...(Array.isArray(capabilities)
                ? capabilities.filter(
                    (flag): flag is string => typeof flag === 'string',
                  )
                : []),
              'reasoning',
            ]),
          ],
          factSources: {
            reasoning: hit.source,
            capabilities: { reasoning: hit.source },
          },
        }
      },
    })
    if (listed.models.length === 0) return listed
    const pricing = await deepseekModelPricing(kv)
    const replay = listed.models.some((model) => model.reasoning != null)
      ? await loadReplayDoc(DEEPSEEK_THINKING_URL, kv)
      : null
    if (replay) parseDeepseekReplay(replay.text)
    return {
      ...listed,
      models: listed.models.map((model) => {
        const priced = { ...model, ...pricing(model.rawId) }
        return replay && model.reasoning != null
          ? applyReplay(priced, replay.source)
          : priced
      }),
    }
  },
  classify: (path) => classifyOpenAiCompat(path),
  generationEndpointId: ({ activity }) => compatGenerationEndpointId(activity),
}
