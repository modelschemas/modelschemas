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
  mapConcurrent,
  markdownSection,
  markdownTableRows,
  tokenCount,
} from './model-facts.ts'
import type { ModelFacts } from './model-facts.ts'
import { fetchJson, fetchText, sha256Text, skippedResult } from './types.ts'
import type {
  ListModelsResult,
  ModelReasoning,
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
const GROK_MODEL_PAGE = (id: string) =>
  `https://docs.x.ai/developers/models/${id}.md`

/**
 * A model page's Capabilities bullets: `**Reasoning:** Yes` and
 * `**Reasoning efforts (supported):** `low`, …`. Reasoning is optional only
 * when `none` is listed; a reasoning model whose page names no efforts has
 * no documented knob and stays null. xAI documents no per-model tool list.
 */
export function parseGrokReasoning(markdown: string): ModelReasoning | null {
  const caps = markdownSection(markdown, 'Capabilities')
  if (!/\*\*Reasoning:\*\*\s*Yes/.test(caps)) return null
  const line = caps.match(/\*\*Reasoning efforts \(supported\):\*\*(.+)/)?.[1]
  const efforts = [...(line ?? '').matchAll(/`([a-z]+)`/g)].flatMap((m) =>
    m[1] ? [m[1]] : [],
  )
  if (efforts.length === 0) return null
  return { mode: 'effort', mandatory: !efforts.includes('none'), efforts }
}

/**
 * Reasoning is on, but the page names no effort list. The object stays
 * null; callers record `path: 'silent'` instead of guessing a mode.
 */
export function grokReasoningGap(markdown: string): 'silent' | null {
  if (parseGrokReasoning(markdown)) return null
  return grokReasons(markdown) ? 'silent' : null
}

/** `**Reasoning:** Yes` in the Capabilities bullets, efforts or not. */
export function grokReasons(markdown: string): boolean {
  return /\*\*Reasoning:\*\*\s*Yes/.test(
    markdownSection(markdown, 'Capabilities'),
  )
}

/**
 * A numeric generation cap from the model page. "No text output limit"
 * and price rows ("Output | $6.00") are not caps.
 */
export function parseGrokMaxOutput(markdown: string): number | null {
  const labeled = markdown.match(
    /\*\*(?:Max(?:imum)? output(?: tokens)?|Output limit):\*\*\s*([^\n]+)/i,
  )?.[1]
  if (labeled) return grokOutputLimit(labeled)
  for (const row of markdownTableRows(markdown)) {
    const label = row[0]?.trim() ?? ''
    const value = row[1]?.trim() ?? ''
    if (/^(?:max(?:imum)? output(?: tokens)?|output limit)$/i.test(label)) {
      return grokOutputLimit(value)
    }
  }
  return null
}

function grokOutputLimit(text: string): number | null {
  if (!/\d/.test(text) || /\bno\b/i.test(text) || text.includes('$')) {
    return null
  }
  return tokenCount(text)
}

/** Listing fields that state an output cap. Absent on the live table. */
function listingMaxOutput(m: GrokExtrasModel): number | null {
  for (const key of [
    'max_output_tokens',
    'max_completion_tokens',
    'max_output',
  ]) {
    const value = m[key]
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return value
    }
  }
  return null
}

/**
 * xAI publishes no per-model tool type list (issue #123). A capabilities
 * page that mentions search still does not name `tools[].type` ids.
 */
export function grokServerTools(_markdown: string): null {
  return null
}

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
 * Image-card levers that are real `/v1/images/generations` fields.
 * `quality` is published on the price matrix and is not one of them.
 */
const GROK_IMAGE_REQUEST_FIELDS = new Set(['n', 'resolution'])

/**
 * The price dimension that blocks a card, when the listing's matrix
 * depends on a field the image request does not accept. `null` when every
 * dimension is a request field (or there is no matrix).
 */
function recordKeys(value: unknown): Array<string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return []
  }
  return Object.keys(value)
}

export function grokImageUnpricedField(m: GrokExtrasModel): string | null {
  const matrix: unknown = m.pricing
  if (!Array.isArray(matrix)) return null
  const blocked = new Set<string>()
  let varies = false
  for (const tier of matrix) {
    for (const key of recordKeys(tier)) {
      if (key === 'price_per_image') continue
      varies = true
      if (!GROK_IMAGE_REQUEST_FIELDS.has(key)) blocked.add(key)
    }
  }
  // A tier key other than price_per_image means image_price is one cell,
  // not the rate for every request. Do not compile that flat number.
  if (!varies) return null
  if (blocked.has('quality')) return 'quality'
  return [...blocked][0] ?? 'resolution'
}

/**
 * Per-image card from the model metadata. A model whose `pricing` table
 * varies the price by `quality` has no card: `quality` is not a field of
 * `/v1/images/generations`, so the rate could only be guessed at. A flat
 * `image_price` is used only when that matrix is absent.
 */
export async function grokImageCard(
  m: GrokExtrasModel,
): Promise<RateCard | null> {
  if (grokImageUnpricedField(m) !== null) return null
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
  const pages = new Map<
    string,
    {
      value: ModelReasoning | null
      reasons?: boolean
      maxOutput: number | null
      hash: string
    }
  >()
  await mapConcurrent(language.models ?? [], 8, async (m) => {
    try {
      const page = await cachedDocs(kv, GROK_MODEL_PAGE(m.id), async () => {
        const markdown = await fetchText(GROK_MODEL_PAGE(m.id))
        return {
          value: parseGrokReasoning(markdown),
          reasons: grokReasons(markdown),
          maxOutput: parseGrokMaxOutput(markdown),
          hash: await sha256Text(markdown),
        }
      })
      if (!page.value && !page.reasons && page.maxOutput == null) return
      for (const id of [m.id, ...(m.aliases ?? [])]) pages.set(id, page)
    } catch {
      // A missing page leaves reasoning and maxOutput unknown, never a guess.
    }
  })
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
    const page = pages.get(rawId)
    const reasons = page?.reasons === true
    const listedMax = listingMaxOutput(m)
    const facts: ModelFacts = {
      contextWindow,
      // The spec's 128k figure is a default, not a cap. Only a number the
      // listing or the model page states is an output limit.
      maxOutput: listedMax ?? page?.maxOutput ?? null,
      modalities,
      // Request-feature flags come from the bound schema; the per-model
      // docs page adds `reasoning`, which no request property names.
      capabilities: reasons ? ['reasoning'] : null,
      pricing: cards.get(rawId) ?? null,
      reasoning: page?.value ?? null,
    }
    const sources: ModelFacts['factSources'] = {}
    if (contextWindow != null) {
      sources.contextWindow = {
        derivation: 'docs-derived',
        sourceUrl: GROK_DOCS_MODELS_URL,
        path: 'contextWindow',
      }
    }
    if (listedMax != null) {
      sources.maxOutput = { derivation: 'listing', path: 'maxOutput' }
    } else if (page?.maxOutput != null) {
      sources.maxOutput = {
        derivation: 'docs-derived',
        sourceUrl: GROK_MODEL_PAGE(m.id),
        sourceHash: page.hash,
        path: 'maxOutput',
      }
    }
    if (page?.value) {
      sources.reasoning = {
        derivation: 'docs-derived',
        sourceUrl: GROK_MODEL_PAGE(m.id),
        sourceHash: page.hash,
        path: 'Capabilities',
      }
    } else if (page?.reasons) {
      sources.reasoning = {
        derivation: 'docs-derived',
        sourceUrl: GROK_MODEL_PAGE(m.id),
        sourceHash: page.hash,
        path: 'silent',
      }
    }
    if (reasons) {
      sources.capabilities = {
        reasoning: {
          derivation: 'docs-derived',
          sourceUrl: GROK_MODEL_PAGE(m.id),
          sourceHash: page.hash,
          path: 'Capabilities.Reasoning',
        },
      }
    }
    if (Object.keys(sources).length > 0) facts.factSources = sources
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
