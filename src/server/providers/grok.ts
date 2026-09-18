/**
 * xAI Grok — first-party OpenAPI 3.1 spec at docs.x.ai/openapi.json
 * (public). Provider id `grok` matches the @tanstack/ai-grok adapter even
 * though xAI titles the spec "xAI's REST API".
 */
import { compileTokenCard, compileUnitCard } from '@modelschemas/rate-card'
import type { RateCard } from '@modelschemas/rate-card'

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
  long_context_threshold?: number
  [price: string]: unknown
}

/**
 * xAI quotes every price as an integer in units of 1e-10 USD per token
 * (`prompt_text_token_price: 12500` is $1.25 / 1M tokens, the rate its
 * docs table publishes). `*_long_context` fields re-quote the whole
 * request once the prompt reaches `long_context_threshold`.
 */
const XAI_PRICE_UNIT = 1e-10

const GROK_PRICE_LEVERS: Record<string, string> = {
  prompt_text_token_price: 'input_tokens',
  cached_prompt_text_token_price: 'cache_read_tokens',
  prompt_image_token_price: 'image_tokens',
  completion_text_token_price: 'output_tokens',
  search_price: 'web_searches',
}

function grokRates(m: GrokExtrasModel, suffix = ''): Record<string, number> {
  const rates: Record<string, number> = {}
  for (const [field, lever] of Object.entries(GROK_PRICE_LEVERS)) {
    const value = m[`${field}${suffix}`]
    if (typeof value === 'number') rates[lever] = value * XAI_PRICE_UNIT
  }
  return rates
}

/**
 * Per-image card from the model metadata. A model whose `pricing` table
 * varies the price by `quality` has no card: `quality` is not a field of
 * `/v1/images/generations`, so the rate could only be guessed at.
 */
export async function grokImageCard(
  m: GrokExtrasModel,
): Promise<RateCard | null> {
  if (Array.isArray(m.pricing)) return null
  const flat = m.image_price
  if (typeof flat !== 'number') return null
  return compileUnitCard(
    {
      // `n` defaults to 1 on the request, as it does here.
      quantity: { param: 'n', bound: 'request', default: 1 },
      rates: flat * XAI_PRICE_UNIT,
    },
    {
      url: GROK_IMAGE_MODELS_URL,
      hash: await sha256Text(JSON.stringify({ image_price: flat })),
      extractedAt: new Date().toISOString(),
    },
  )
}

/**
 * Per-second video rates from the docs "Imagine Pricing" table
 * (`| grok-imagine-video | $0.050 / sec |`). The model metadata carries no
 * price for video models.
 */
export function parseGrokVideoPrices(markdown: string): Map<string, number> {
  const out = new Map<string, number>()
  for (const [model = '', cost = ''] of markdownTableRows(markdown)) {
    const rate = cost.match(/^\$([\d.]+)\s*\/\s*sec(ond)?$/)?.[1]
    if (!/^grok-/.test(model) || rate === undefined) continue
    if (!out.has(model)) out.set(model, Number(rate))
  }
  return out
}

/** Per-second card for a video model the docs table prices. */
export async function grokVideoCard(
  perSecond: number | undefined,
): Promise<RateCard | null> {
  if (perSecond === undefined) return null
  return compileUnitCard(
    { quantity: { param: 'duration', bound: 'request' }, rates: perSecond },
    {
      url: GROK_DOCS_MODELS_URL,
      hash: await sha256Text(JSON.stringify({ perSecond })),
      extractedAt: new Date().toISOString(),
    },
  )
}

/** Per-model token card from the first-party model metadata. */
export async function grokRateCard(
  m: GrokExtrasModel,
): Promise<RateCard | null> {
  const base = grokRates(m)
  if (Object.keys(base).length === 0) return null
  const long = grokRates(m, '_long_context')
  const threshold = m.long_context_threshold
  const tiers =
    typeof threshold === 'number' && Object.keys(long).length > 0
      ? // xAI bills the long-context rate at or above the threshold; the
        // card's tiers are strictly-greater, and token counts are integers.
        [{ minPromptTokens: threshold - 1, rates: { ...base, ...long } }]
      : []
  return compileTokenCard(base, tiers, {
    url: GROK_LANGUAGE_MODELS_URL,
    // Hashing only the priced fields keeps the stored card (and its
    // `extractedAt`) stable across unrelated metadata edits.
    hash: await sha256Text(
      JSON.stringify({ base, long, threshold: threshold ?? null }),
    ),
    extractedAt: new Date().toISOString(),
  })
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
  const [language, image, video, docs] = await Promise.all([
    extras(GROK_LANGUAGE_MODELS_URL),
    extras(GROK_IMAGE_MODELS_URL),
    extras(GROK_VIDEO_MODELS_URL),
    cachedDocs(kv, GROK_DOCS_MODELS_URL, async () => {
      const markdown = await fetchText(GROK_DOCS_MODELS_URL)
      const parsed = parseGrokContextWindows(markdown)
      assertParsed(parsed, 'xai models docs')
      return {
        contexts: Object.fromEntries(parsed),
        videoPerSecond: Object.fromEntries(parseGrokVideoPrices(markdown)),
      }
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
  const cards = new Map<string, RateCard | null>()
  for (const m of language.models ?? []) {
    const card = await grokRateCard(m)
    for (const id of [m.id, ...(m.aliases ?? [])]) cards.set(id, card)
  }
  for (const m of image.models ?? []) {
    const card = await grokImageCard(m)
    for (const id of [m.id, ...(m.aliases ?? [])]) cards.set(id, card)
  }
  for (const m of video.models ?? []) {
    const card = await grokVideoCard(docs.videoPerSecond[m.id])
    for (const id of [m.id, ...(m.aliases ?? [])]) cards.set(id, card)
  }
  return (rawId) => {
    const m = byId.get(rawId)
    if (!m) return NO_FACTS
    const contextWindow = docs.contexts[rawId] ?? null
    const modalities = m.input_modalities
      ? { input: m.input_modalities, output: m.output_modalities ?? [] }
      : null
    const facts: ModelFacts = {
      contextWindow,
      maxOutput: null,
      modalities,
      // xAI publishes no request-feature flags on any endpoint or doc table.
      capabilities: null,
      pricing: cards.get(rawId) ?? null,
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
