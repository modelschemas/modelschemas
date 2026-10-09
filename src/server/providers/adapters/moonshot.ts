/**
 * Moonshot (Kimi) — international surface. Spec is
 * platform.kimi.ai/docs/openapi.json (`servers.url` = api.moonshot.ai).
 * Keys are region-bound: this host accepts international keys; a CN key
 * 401s here the same way an international key 401s on api.moonshot.cn.
 * Generation is POST /v1/chat/completions; files, batches, billing, and
 * token-estimate classify as platform.
 *
 * The spec's chat request is a per-model union, as on the China host. A
 * model whose own branch takes only the `thinking.type` switch gets a
 * toggle from it. A failed spec read leaves the stored value alone.
 */
import {
  applyReplay,
  KIMI_THINKING_URL,
  loadReplayDoc,
  parseKimiReplay,
} from '../provider-replay.ts'
import { docsReport, docsRun, tryDocs, unavailable } from '../model-facts.ts'
import { moonshotModelPricing } from '../moonshot-pricing.ts'
import {
  classifyOpenAiCompat,
  listOpenAiCompatibleModels,
} from '../openai-compat.ts'
import {
  compatGenerationEndpointId,
  flaggedChatModalities,
  moonshotModelActivity,
} from '../model-meta.ts'
import { fetchOpenApi } from '../types.ts'
import type {
  ListModelsResult,
  ModelInfo,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'
import { moonshotChatFacts } from './moonshotai-cn.ts'
import type { MoonshotHost } from './moonshotai-cn.ts'

const MOONSHOT_OPENAPI_URL = 'https://platform.kimi.ai/docs/openapi.json'
const MOONSHOT_MODELS_URL = 'https://api.moonshot.ai/v1/models'

const HOST: MoonshotHost = {
  label: 'moonshot',
  server: 'https://api.moonshot.ai',
  specUrl: MOONSHOT_OPENAPI_URL,
}

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const { spec, hash } = await fetchOpenApi(MOONSHOT_OPENAPI_URL)
  return {
    specs: [spec],
    sources: [{ url: MOONSHOT_OPENAPI_URL, hash }],
    outputStrategy: 'post-200',
  }
}

async function listModels(
  env: ProviderSecrets,
  kv?: KVNamespace,
): Promise<ListModelsResult> {
  const listed = await listOpenAiCompatibleModels({
    providerId: 'moonshot',
    url: MOONSHOT_MODELS_URL,
    env,
    envVar: 'MOONSHOT_API_KEY',
    activity: moonshotModelActivity,
    extend: async (row) =>
      row.supports_image_in !== undefined || row.supports_video_in !== undefined
        ? { modalities: flaggedChatModalities(row) }
        : {},
  })
  if (listed.models.length === 0) return listed
  const pricing = await moonshotModelPricing(kv)
  const replay = await loadReplayDoc(KIMI_THINKING_URL, kv)
  const replayIds = new Set(parseKimiReplay(replay.text))
  const docs = docsRun()
  const chat = await tryDocs(docs, MOONSHOT_OPENAPI_URL, (cached) =>
    cached(kv, MOONSHOT_OPENAPI_URL, async () => {
      const { spec, hash } = await fetchOpenApi(MOONSHOT_OPENAPI_URL)
      return moonshotChatFacts(spec, hash, HOST)
    }),
  )
  const toggle = (rawId: string): Partial<ModelInfo> => {
    if (!chat) return unavailable('reasoning')
    const facts = chat[rawId]
    // Only the switch is taken here: the listing and the schema walk
    // already supply this host's other facts.
    return facts?.reasoning?.mode === 'toggle'
      ? {
          reasoning: facts.reasoning,
          factSources: { reasoning: facts.factSources.reasoning },
        }
      : {}
  }
  return {
    ...listed,
    models: listed.models.map((model) => {
      const over = {
        ...pricing(model.rawId),
        ...toggle(model.rawId),
      }
      const enriched: ModelInfo = {
        ...model,
        ...over,
        // `created` is one clock on every id and it moves forward on each
        // list, so it is not a release date. `cleared` drops a value a
        // previous poll stored from it.
        releasedAt: null,
        absent: { ...model.absent, ...over.absent, releasedAt: 'cleared' },
      }
      return replayIds.has(model.rawId)
        ? applyReplay(enriched, replay.source)
        : enriched
    }),
    docsFailures: docsReport(docs),
  }
}

export const provider: ProviderConfig = {
  id: 'moonshot',
  displayName: 'Moonshot',
  authEnvVar: 'MOONSHOT_API_KEY',
  specSourceUrl: MOONSHOT_OPENAPI_URL,
  modelsEndpoint: MOONSHOT_MODELS_URL,
  defaultDerivation: 'upstream-spec',
  fetchSpec,
  listModels,
  classify: classifyOpenAiCompat,
  generationEndpointId: ({ activity }) =>
    compatGenerationEndpointId(activity, 'v1/'),
}
