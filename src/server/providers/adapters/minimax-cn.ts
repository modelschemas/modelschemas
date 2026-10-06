/**
 * MiniMax (China) — model ids from the public models overview (platform.minimaxi.com).
 * Chat rows take their facts from the China docs pages, read by the parsers
 * in `minimax-docs.ts`. The spec is the two chat documents the China docs
 * site publishes. Prices on the pay-as-you-go page are yuan. Rate cards
 * are USD, so prices stay null.
 */
import type { Activity } from '#/db/schema.ts'

import { tagDocsFacts } from '../fact-sources.ts'
import {
  fetchMinimaxPage,
  MINIMAX_CN,
  MINIMAX_CN_MESSAGES_SPEC_URL,
  minimaxModelFacts,
} from '../minimax-docs.ts'
import { sha256Text } from '../types.ts'
import type {
  ListModelsResult,
  ModelInfo,
  OpenApiDocument,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

export const MINIMAX_CN_MODELS_URL =
  'https://platform.minimaxi.com/docs/guides/models-intro.md'

const SPEC_URLS = [MINIMAX_CN.chatSpecUrl, MINIMAX_CN_MESSAGES_SPEC_URL]
const CHAT_ENDPOINT = 'v1/chat/completions'

function fetchPage(url: string): Promise<string> {
  return fetchMinimaxPage(url, MINIMAX_CN)
}

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

export function parseMinimaxCnModels(markdown: string): Array<ModelInfo> {
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
    throw new Error('minimax-cn: models page listed no ids')
  }
  return models
}

async function listModels(
  _env: ProviderSecrets,
  kv?: KVNamespace,
): Promise<ListModelsResult> {
  const markdown = await fetchPage(MINIMAX_CN_MODELS_URL)
  const facts = await minimaxModelFacts(kv, MINIMAX_CN)
  return {
    models: parseMinimaxCnModels(markdown).map((model) => {
      if (model.activity !== 'chat') return model
      const fact = facts(model.rawId)
      // An id the docs pages do not name gets no facts and no route.
      if (Object.keys(fact).length === 0) return model
      // The chat spec says only the model with an effort list acts on
      // `reasoning_effort`, so the shared schema does not set the flag.
      const capabilities = fact.reasoning?.efforts ? ['reasoning_effort'] : null
      return {
        ...model,
        ...fact,
        ...(capabilities ? { capabilities } : {}),
        schemaEndpointId: CHAT_ENDPOINT,
        factSources: {
          ...fact.factSources,
          ...tagDocsFacts(
            { capabilities },
            MINIMAX_CN.chatSpecUrl,
            fact.factSources?.maxOutput?.sourceHash,
          ),
        },
      }
    }),
  }
}

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const docs = await Promise.all(
    SPEC_URLS.map(async (url) => {
      const text = await fetchPage(url)
      const spec = JSON.parse(text) as OpenApiDocument
      return { url, spec, hash: await sha256Text(text) }
    }),
  )
  return {
    specs: docs.map((doc) => doc.spec),
    sources: docs.map(({ url, hash }) => ({ url, hash })),
    outputStrategy: 'post-200',
  }
}

export const provider: ProviderConfig = {
  id: 'minimax-cn',
  displayName: 'MiniMax (China)',
  specSourceUrl: MINIMAX_CN.chatSpecUrl,
  modelsEndpoint: MINIMAX_CN_MODELS_URL,
  defaultDerivation: 'upstream-spec',
  // A poll can run before the first sync creates the chat endpoint.
  bindSyncedRoutesOnly: true,
  fetchSpec,
  listModels,
  classify: (path) =>
    path === '/v1/chat/completions' || path === '/anthropic/v1/messages'
      ? 'chat'
      : null,
  perModelSchemaFlags: ['reasoning_effort'],
}
