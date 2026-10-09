import {
  DEEPSEEK_CHAT_DOCS,
  fetchNativeDeepseekSpec,
} from '../deepseek-native-spec.ts'
/** DeepSeek — native operation JSON from its own published API docs. */
import {
  applyReplay,
  deepseekEffortFacts,
  DEEPSEEK_THINKING_URL,
  loadReplayDoc,
  parseDeepseekReplay,
} from '../provider-replay.ts'
import { deepseekModelPricing } from '../deepseek-pricing.ts'
import {
  listOpenAiCompatibleModels,
  openAiCompatModelFacts,
} from '../openai-compat.ts'
import { deepseekModelActivity } from '../model-meta.ts'
import type {
  ListModelsResult,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

const DEEPSEEK_MODELS_URL = 'https://api.deepseek.com/models'

function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  return fetchNativeDeepseekSpec()
}

export const provider: ProviderConfig = {
  id: 'deepseek',
  displayName: 'DeepSeek',
  authEnvVar: 'DEEPSEEK_API_KEY',
  specSourceUrl: DEEPSEEK_CHAT_DOCS,
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
  classify: (_path, operation) =>
    _path === '/chat/completions' &&
    operation['x-modelschemas-deepseek-native'] === true
      ? 'chat'
      : null,
  generationEndpointId: ({ activity }) =>
    activity === 'chat' ? 'chat/completions' : null,
}
