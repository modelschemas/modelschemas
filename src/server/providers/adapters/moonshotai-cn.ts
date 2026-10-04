/**
 * Moonshot AI (China) — model ids from platform.moonshot.cn pricing docs.
 * Amounts on that page are yuan. Rate cards are USD, so prices stay null.
 * Context windows are the token counts the page names.
 */
import { fetchText } from '../types.ts'
import type {
  ListModelsResult,
  ModelInfo,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

export const MOONSHOT_CN_PRICING_URL =
  'https://platform.moonshot.cn/docs/pricing.md'

const SPEC_SKIP = 'moonshotai-cn: no first-party OpenAPI document — skipped'

export function parseMoonshotCnModels(markdown: string): Array<ModelInfo> {
  const models: Array<ModelInfo> = []
  const seen = new Set<string>()
  for (const match of markdown.matchAll(
    /\["((?:kimi|moonshot)-[^"]+)"([\s\S]*?)\]/g,
  )) {
    const rawId = match[1]
    const body = match[2] ?? ''
    if (!rawId || seen.has(rawId)) continue
    seen.add(rawId)
    const windows = [...body.matchAll(/"([0-9,]+) tokens"/g)]
    const last = windows.at(-1)?.[1]
    const contextWindow = last ? Number(last.replace(/,/g, '')) : null
    models.push({
      rawId,
      contextWindow:
        contextWindow !== null && Number.isFinite(contextWindow)
          ? contextWindow
          : null,
      pricing: null,
    })
  }
  if (models.length === 0) {
    throw new Error('moonshotai-cn: pricing page listed no ids')
  }
  return models
}

async function listModels(_env: ProviderSecrets): Promise<ListModelsResult> {
  const markdown = await fetchText(MOONSHOT_CN_PRICING_URL)
  return { models: parseMoonshotCnModels(markdown) }
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
  id: 'moonshotai-cn',
  displayName: 'Moonshot AI (China)',
  specSourceUrl: 'https://platform.moonshot.cn/docs/api/chat',
  modelsEndpoint: MOONSHOT_CN_PRICING_URL,
  defaultDerivation: 'docs-derived',
  fetchSpec,
  listModels,
  classify: () => null,
}
