/**
 * xAI Grok — first-party OpenAPI 3.1 spec at docs.x.ai/openapi.json
 * (public). Provider id `grok` matches the @tanstack/ai-grok adapter even
 * though xAI titles the spec "xAI's REST API".
 */
import type { Activity } from '#/db/schema.ts'
import { bearerConnect } from './connect.ts'
import {
  displayNameFromRawId,
  grokGenerationEndpointId,
  grokModelActivity,
} from './model-meta.ts'
import {
  NO_FACTS,
  assertParsed,
  cachedDocs,
  markdownTableRows,
  tokenCount,
} from './model-facts.ts'
import type { ModelFacts } from './model-facts.ts'
import { fetchJson, fetchText, sha256Text, skippedResult } from './types.ts'
import type {
  ListModelsResult,
  OpenApiDocument,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from './types.ts'

const GROK_OPENAPI_URL = 'https://docs.x.ai/openapi.json'
const GROK_MODELS_URL = 'https://api.x.ai/v1/models'
/**
 * First-party extras: per-family model endpoints carry modalities (and
 * prices — a separate PR). Context windows are only in the docs, served
 * as markdown with a `| Model | Context | … |` table.
 */
const GROK_LANGUAGE_MODELS_URL = 'https://api.x.ai/v1/language-models'
const GROK_IMAGE_MODELS_URL = 'https://api.x.ai/v1/image-generation-models'
const GROK_VIDEO_MODELS_URL = 'https://api.x.ai/v1/video-generation-models'
export const GROK_DOCS_MODELS_URL = 'https://docs.x.ai/docs/models.md'

/**
 * xAI tags every operation `v1`, so classify by path. The text-generation
 * surface spans the OpenAI-compatible endpoints (chat/completions,
 * completions, responses) and the Anthropic-compatible ones (messages,
 * complete). Files and document search are platform endpoints.
 */
function classify(path: string): Activity | null {
  if (
    path === '/v1/chat/completions' ||
    path === '/v1/completions' ||
    path === '/v1/complete' ||
    path === '/v1/messages' ||
    path === '/v1/responses' ||
    path === '/v1/tokenize-text'
  ) {
    return 'chat'
  }
  if (path.startsWith('/v1/images/')) return 'image'
  if (path.startsWith('/v1/videos/')) return 'video'
  if (path === '/v1/embeddings') return 'embeddings'
  return null
}

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const text = await fetchText(GROK_OPENAPI_URL)
  const spec = JSON.parse(text) as OpenApiDocument
  return {
    specs: [spec],
    sources: [{ url: GROK_OPENAPI_URL, hash: await sha256Text(text) }],
    outputStrategy: 'post-200',
  }
}

interface GrokModelList {
  data?: Array<{ id: string; created?: number }>
}

interface GrokExtrasModel {
  id: string
  aliases?: Array<string>
  input_modalities?: Array<string>
  output_modalities?: Array<string>
}

/** Context windows keyed by model id from the docs pricing table. */
export function parseGrokContextWindows(markdown: string): Map<string, number> {
  const out = new Map<string, number>()
  for (const [model = '', context = ''] of markdownTableRows(markdown)) {
    const id = model.replace(/\s*\(.*$/, '').trim()
    if (!/^grok-/.test(id) || !/^[\d,.]+\s*[kKmM]?$/.test(context)) continue
    const tokens = tokenCount(context)
    if (tokens !== null && !out.has(id)) out.set(id, tokens)
  }
  return out
}

async function grokModelFacts(
  headers: HeadersInit,
  kv: KVNamespace | undefined,
): Promise<(rawId: string) => ModelFacts> {
  const extras = (url: string) =>
    fetchJson(url, { headers }) as Promise<{ models?: Array<GrokExtrasModel> }>
  const [language, image, video, contexts] = await Promise.all([
    extras(GROK_LANGUAGE_MODELS_URL),
    extras(GROK_IMAGE_MODELS_URL),
    extras(GROK_VIDEO_MODELS_URL),
    cachedDocs(kv, GROK_DOCS_MODELS_URL, async () => {
      const parsed = parseGrokContextWindows(
        await fetchText(GROK_DOCS_MODELS_URL),
      )
      assertParsed(parsed, 'xai models docs')
      return Object.fromEntries(parsed)
    }),
  ])
  const byId = new Map<string, GrokExtrasModel>()
  for (const m of [
    ...(language.models ?? []),
    ...(image.models ?? []),
    ...(video.models ?? []),
  ]) {
    for (const id of [m.id, ...(m.aliases ?? [])]) byId.set(id, m)
  }
  return (rawId) => {
    const m = byId.get(rawId)
    if (!m) return NO_FACTS
    const contextWindow = contexts[rawId] ?? null
    const modalities = m.input_modalities
      ? { input: m.input_modalities, output: m.output_modalities ?? [] }
      : null
    const facts: ModelFacts = {
      contextWindow,
      maxOutput: null,
      modalities,
      // xAI publishes no request-feature flags on any endpoint or doc table.
      capabilities: null,
    }
    if (contextWindow != null) {
      facts.factSources = {
        contextWindow: {
          derivation: 'docs-derived',
          sourceUrl: GROK_DOCS_MODELS_URL,
          path: 'contextWindow',
        },
      }
    }
    return facts
  }
}

async function listModels(
  env: ProviderSecrets,
  kv?: KVNamespace,
): Promise<ListModelsResult> {
  const key = env.XAI_API_KEY
  if (!key) {
    return { models: [], ...skippedResult('grok', 'XAI_API_KEY') }
  }
  const headers = { Authorization: `Bearer ${key}` }
  const [body, facts] = await Promise.all([
    fetchJson(GROK_MODELS_URL, { headers }) as Promise<GrokModelList>,
    grokModelFacts(headers, kv),
  ])
  return {
    models: (body.data ?? []).map((m) => ({
      rawId: m.id,
      displayName: displayNameFromRawId(m.id),
      activity: grokModelActivity(m.id),
      releasedAt: m.created ?? null,
      ...facts(m.id),
    })),
  }
}

export const grokProvider: ProviderConfig = {
  id: 'grok',
  displayName: 'xAI Grok',
  authEnvVar: 'XAI_API_KEY',
  defaultDerivation: 'upstream-spec',
  specGrain: 'provider',
  connect: bearerConnect('https://api.x.ai'),
  fetchSpec,
  listModels,
  classify,
  generationEndpointId: ({ activity }) => grokGenerationEndpointId(activity),
}
