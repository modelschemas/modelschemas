/**
 * MiniMax — model ids from the public models overview (platform.minimax.io).
 * This models page does not name token prices, so prices stay null.
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

export const MINIMAX_MODELS_URL =
  'https://platform.minimax.io/docs/guides/models-intro.md'

const SPEC_SKIP = 'minimax: no first-party OpenAPI document — skipped'

const SECTION_ACTIVITY: Array<[RegExp, Activity | null]> = [
  [/^Language|^语言模型/, 'chat'],
  [/^Video|^视频/, 'video'],
  [/^Speech|^Audio|^语音/, 'audio'],
  [/^Image|^图片/, 'image'],
  [/^Music|^音乐/, null],
]

const WIRE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** First-column link whose label is a wire id. Spaced display names stay out. */
function modelColumnId(line: string): string | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('|') || /^\|\s*:?-+/.test(trimmed)) return null
  const first = trimmed.split('|')[1]?.trim() ?? ''
  const markdown = first.match(/^\[([^\]]+)\]\([^)]+\)$/)
  const anchor = first.match(/^<a\b[^>]*>\s*([^<]+?)\s*<\/a>$/)
  const label = (markdown?.[1] ?? anchor?.[1] ?? '').trim()
  return WIRE_ID.test(label) ? label : null
}

export function parseMinimaxModels(markdown: string): Array<ModelInfo> {
  const models: Array<ModelInfo> = []
  const seen = new Set<string>()
  for (const chunk of markdown.split(/^### /m).slice(1)) {
    const newline = chunk.indexOf('\n')
    const title = newline === -1 ? chunk : chunk.slice(0, newline)
    const known = SECTION_ACTIVITY.find(([pattern]) => pattern.test(title))
    const activity = known ? known[1] : null
    for (const line of chunk.split('\n')) {
      const rawId = modelColumnId(line)
      if (!rawId || seen.has(rawId)) continue
      seen.add(rawId)
      models.push({ rawId, activity, pricing: null })
    }
  }
  if (models.length === 0) {
    throw new Error('minimax: models page listed no ids')
  }
  return models
}

async function listModels(_env: ProviderSecrets): Promise<ListModelsResult> {
  const markdown = await fetchText(MINIMAX_MODELS_URL)
  return { models: parseMinimaxModels(markdown) }
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
  id: 'minimax',
  displayName: 'MiniMax',
  specSourceUrl: 'https://platform.minimax.io/docs/guides/quickstart',
  modelsEndpoint: MINIMAX_MODELS_URL,
  defaultDerivation: 'docs-derived',
  fetchSpec,
  listModels,
  classify: () => null,
}
