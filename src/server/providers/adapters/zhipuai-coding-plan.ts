/**
 * Zhipu AI Coding Plan — model ids named on the Coding Plan docs.
 * The overview lists the models every plan can call. The switch guide names
 * the wire ids, including the `[1m]` context suffix. Point coefficients are
 * not USD, so prices stay null.
 */
import { fetchText } from '../types.ts'
import type {
  ListModelsResult,
  ModelInfo,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

export const ZHIPU_CODING_OVERVIEW_URL =
  'https://docs.bigmodel.cn/cn/coding-plan/overview.md'
export const ZHIPU_CODING_MODELS_URL =
  'https://docs.bigmodel.cn/cn/coding-plan/latest-model.md'

const SPEC_SKIP =
  'zhipuai-coding-plan: no first-party OpenAPI document — skipped'

const WIRE_ID =
  /`((?:glm)-[a-z0-9.-]+(?:\[1m\])?)`|"((?:glm)-[a-z0-9.-]+(?:\[1m\])?)"/g

export function parseZhipuCodingModels(
  overview: string,
  latest: string,
): Array<ModelInfo> {
  const ids = new Set<string>()
  for (const line of overview.split('\n')) {
    if (!line.includes('所有套餐均支持')) continue
    for (const name of line.match(/GLM-[A-Za-z0-9.-]+/g) ?? []) {
      ids.add(name.toLowerCase())
    }
  }
  for (const doc of [overview, latest]) {
    for (const match of doc.matchAll(WIRE_ID)) {
      const id = match[1] ?? match[2]
      if (id) ids.add(id)
    }
  }
  if (ids.size === 0) {
    throw new Error('zhipuai-coding-plan: docs listed no model ids')
  }
  return [...ids].sort().map((rawId) => ({
    rawId,
    pricing: null,
  }))
}

async function listModels(_env: ProviderSecrets): Promise<ListModelsResult> {
  const [overview, latest] = await Promise.all([
    fetchText(ZHIPU_CODING_OVERVIEW_URL),
    fetchText(ZHIPU_CODING_MODELS_URL),
  ])
  return { models: parseZhipuCodingModels(overview, latest) }
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
  id: 'zhipuai-coding-plan',
  displayName: 'Zhipu AI Coding Plan',
  specSourceUrl: 'https://docs.bigmodel.cn/cn/coding-plan/overview',
  modelsEndpoint: ZHIPU_CODING_MODELS_URL,
  defaultDerivation: 'docs-derived',
  fetchSpec,
  listModels,
  classify: () => null,
}
