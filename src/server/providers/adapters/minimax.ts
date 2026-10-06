/**
 * MiniMax — model ids from the public models overview (platform.minimax.io).
 * Chat rows take their facts from the docs pages in `minimax-docs.ts`. The
 * spec is the two chat documents the docs site publishes: OpenAI-compatible
 * chat completions and Anthropic-compatible messages.
 */
import type { Activity } from '#/db/schema.ts'

import {
  MINIMAX_CHAT_SPEC_URL,
  MINIMAX_MESSAGES_SPEC_URL,
  minimaxModelFacts,
} from '../minimax-docs.ts'
import { fetchOpenApi, fetchText } from '../types.ts'
import type {
  ListModelsResult,
  ModelInfo,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

export const MINIMAX_MODELS_URL =
  'https://platform.minimax.io/docs/guides/models-intro.md'

const SPEC_URLS = [MINIMAX_CHAT_SPEC_URL, MINIMAX_MESSAGES_SPEC_URL]

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

async function listModels(
  _env: ProviderSecrets,
  kv?: KVNamespace,
): Promise<ListModelsResult> {
  const markdown = await fetchText(MINIMAX_MODELS_URL)
  const facts = await minimaxModelFacts(kv)
  return {
    models: parseMinimaxModels(markdown).map((model) =>
      model.activity === 'chat' ? { ...model, ...facts(model.rawId) } : model,
    ),
  }
}

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const docs = await Promise.all(
    SPEC_URLS.map(async (url) => ({ url, ...(await fetchOpenApi(url)) })),
  )
  return {
    specs: docs.map((doc) => doc.spec),
    sources: docs.map(({ url, hash }) => ({ url, hash })),
    outputStrategy: 'post-200',
  }
}

export const provider: ProviderConfig = {
  id: 'minimax',
  displayName: 'MiniMax',
  specSourceUrl: MINIMAX_CHAT_SPEC_URL,
  modelsEndpoint: MINIMAX_MODELS_URL,
  defaultDerivation: 'upstream-spec',
  fetchSpec,
  listModels,
  classify: (path) =>
    path === '/v1/chat/completions' || path === '/anthropic/v1/messages'
      ? 'chat'
      : null,
  generationEndpointId: ({ activity }) =>
    activity === 'chat' ? 'v1/chat/completions' : null,
}
