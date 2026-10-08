/**
 * Alibaba Cloud Model Studio (DashScope) — OpenAI-compatible mode.
 * No published OpenAPI; schemas are generated from OpenAI's spec.
 * Intl host; China is dashscope.aliyuncs.com.
 *
 * The compatible-mode models list is id-only. Activity, modalities, and
 * prices come from GET /api/v1/models (issue #109).
 */
import { compileTokenCard, compileUnitCard } from '@modelschemas/rate-card'
import type { RateCard, TokenRateTier } from '@modelschemas/rate-card'

import {
  DASHSCOPE_COMPAT_SCOPE,
  DASHSCOPE_COMPAT_URL,
  dashscopeCompatCovers,
  parseDashscopeCompat,
  parseDashscopeCompatScope,
} from '../dashscope-compat.ts'
import type { DashscopeCompatFacts } from '../dashscope-compat.ts'
import {
  dashscopeModelPageUrl,
  loadDashscopeModelLimits,
} from '../dashscope-model-limits.ts'
import type { DashscopeLimitsDoc } from '../dashscope-model-limits.ts'
import { docsReport, docsRun, tryDocs } from '../model-facts.ts'
import {
  compatGenerationEndpointId,
  dashscopeModelActivity,
} from '../model-meta.ts'
import {
  classifyOpenAiCompat,
  fetchOpenAiCompatibleSpec,
} from '../openai-compat.ts'
import type { OpenAiCompatPath } from '../openai-compat.ts'
import { fetchJson, fetchText, sha256Text, skippedResult } from '../types.ts'
import type {
  FactSource,
  ListModelsResult,
  ModelFactSources,
  ModelInfo,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

const SPEC_SOURCE_URL =
  'https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope'
const MODELS_URL = 'https://dashscope-intl.aliyuncs.com/api/v1/models'
const SERVER_URL = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'

/**
 * alibabacloud.com answered the Worker's bare fetch with an HTML page from
 * 2026-10-07 (issue #256); workerd sends no User-Agent or Accept. These
 * match a browser's fetch of the `.md` URL.
 */
const DOCS_INIT: RequestInit = {
  headers: {
    Accept: 'text/markdown,text/plain,*/*',
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  },
}

const INCLUDE: ReadonlyArray<OpenAiCompatPath> = [
  '/chat/completions',
  '/embeddings',
  '/images/generations',
  '/audio/speech',
  '/audio/transcriptions',
]

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const { spec, url, hash } = await fetchOpenAiCompatibleSpec({
    title: 'Alibaba Cloud Model Studio',
    serverUrl: SERVER_URL,
    include: INCLUDE,
  })
  return {
    specs: [spec],
    sources: [{ url, hash }],
    outputStrategy: 'post-200',
  }
}

const TOKEN_LEVERS: Record<string, string> = {
  input_token: 'input_tokens',
  output_token: 'output_tokens',
  omni_input_token: 'input_tokens',
  omni_output_token: 'output_tokens',
  input_token_cache: 'cache_read_tokens',
  omni_input_token_cache: 'cache_read_tokens',
  input_token_cache_read: 'cache_read_tokens',
  input_token_cache_creation_5m: 'cache_write_tokens',
  input_token_cache_creation_1h: 'cache_write_1h_tokens',
}

/**
 * Thinking-only rows publish `thinking_*` and no plain token type. A row
 * that publishes both keeps the plain type: that is the non-thinking price,
 * and the thinking price is a different mode.
 */
const THINKING_ALIAS: Record<string, string> = {
  thinking_input_token: 'input_token',
  thinking_output_token: 'output_token',
  thinking_input_token_cache: 'input_token_cache',
  thinking_input_token_cache_creation_5m: 'input_token_cache_creation_5m',
  thinking_input_token_cache_read: 'input_token_cache_read',
}

const FEATURES: Record<string, Array<string>> = {
  'function-calling': ['tools'],
  'structured-outputs': ['structured_outputs', 'response_format'],
}

interface DashscopePrice {
  type?: string
  price?: string
  price_unit?: string
  time_band?: string | null
}

interface DashscopeRange {
  range_name?: string
  prices?: Array<DashscopePrice>
}

export interface DashscopeListedModel {
  model?: string
  name?: string
  capabilities?: Array<string>
  features?: Array<string>
  prices?: Array<DashscopeRange>
  published_time?: string | null
  inference_metadata?: {
    request_modality?: Array<string>
    response_modality?: Array<string>
  }
  model_info?: {
    context_window?: number | null
    max_output_tokens?: number | null
    /** Published response cap when `max_output_tokens` is null. */
    reasoning_max_output_tokens?: number | null
  }
}

function modalityList(values: Array<string> | undefined): Array<string> {
  return (values ?? []).map((value) => value.toLowerCase())
}

/**
 * Lower bound of a prompt tier. `Default` and an upper bound only
 * (`Input<=32k`) are the base. `32k<Input<=128k` starts above 32k.
 * `256k<Input<=1m` starts above 256k. An unrecognized name is null,
 * and the card is dropped.
 */
export function promptFloor(range: string): number | null {
  const text = range.trim()
  if (text === '' || /^default$/i.test(text)) return 0
  const head = text.split(/[<≤]/, 1)[0] ?? ''
  const bound = head.match(/(\d+(?:\.\d+)?)\s*([km])?\s*$/i)
  if (bound?.[1]) {
    const amount = Number(bound[1])
    const unit = bound[2]?.toLowerCase()
    if (!Number.isFinite(amount)) return null
    return amount * (unit === 'm' ? 1_000_000 : unit === 'k' ? 1_000 : 1)
  }
  if (/[<≤=]/.test(text)) return 0
  return null
}

function positive(price: string | undefined): number | null {
  if (!price || !/^\d+(?:\.\d+)?$/.test(price)) return null
  const value = Number(price)
  return value > 0 ? value : null
}

function standardBand(items: Array<DashscopePrice>): Array<DashscopePrice> {
  const bands = new Set(items.map((item) => item.time_band ?? null))
  if (bands.size <= 1) return items
  return items.filter(
    (item) => item.time_band == null || item.time_band === 'standard',
  )
}

function canonicalType(type: string, present: Set<string>): string | undefined {
  if (TOKEN_LEVERS[type]) return type
  const alias = THINKING_ALIAS[type]
  if (!alias || present.has(alias)) return undefined
  return alias
}

/**
 * Token ranges become a token card. A per-image quote becomes a unit card.
 * An unparsed range, a mixed unit, or an all-zero quote stays null.
 * Explicit cache read is omitted when implicit cache is also quoted.
 * Text, vision, and audio prices that are not one input rate stay null.
 */
export async function dashscopeListedCard(
  ranges: Array<DashscopeRange> | undefined,
): Promise<RateCard | null> {
  if (!ranges || ranges.length === 0) return null
  const parsed: Array<{ floor: number; prices: Array<DashscopePrice> }> = []
  for (const range of ranges) {
    const floor = promptFloor(range.range_name ?? 'Default')
    if (floor === null) return null
    parsed.push({ floor, prices: standardBand(range.prices ?? []) })
  }
  const units = new Set(
    parsed.flatMap((range) =>
      range.prices.map((price) => price.price_unit ?? ''),
    ),
  )
  const source = {
    url: MODELS_URL,
    hash: await sha256Text(JSON.stringify(ranges)),
    extractedAt: new Date().toISOString(),
  }
  if ([...units].every((unit) => /per image/i.test(unit))) {
    const image = positive(parsed[0]?.prices[0]?.price)
    if (parsed.length !== 1 || image === null) return null
    if (parsed[0]?.prices[0]?.type !== 'image_number') return null
    return compileUnitCard(
      {
        quantity: { param: 'images', bound: 'usage' },
        rates: image,
      },
      source,
    )
  }
  if ([...units].some((unit) => !/per (1m|million) tokens/i.test(unit))) {
    return null
  }

  const rateMap = (
    prices: Array<DashscopePrice>,
  ): Record<string, number> | null => {
    const present = new Set(
      prices.flatMap((price) => (price.type ? [price.type] : [])),
    )
    const hasImplicit = prices.some((price) => {
      const type = price.type ? canonicalType(price.type, present) : undefined
      return type === 'input_token_cache' || type === 'omni_input_token_cache'
    })
    const rates: Record<string, number> = {}
    for (const price of prices) {
      const type = price.type ? canonicalType(price.type, present) : undefined
      if (!type || (hasImplicit && type === 'input_token_cache_read')) continue
      const lever = TOKEN_LEVERS[type]
      const amount = positive(price.price)
      if (!lever || amount === null) continue
      if (lever in rates && rates[lever] !== amount / 1e6) return null
      rates[lever] = amount / 1e6
    }
    return rates
  }

  const base = parsed.find((range) => range.floor === 0)
  if (!base) return null
  const baseRates = rateMap(base.prices)
  if (!baseRates) return null
  const tiers: Array<TokenRateTier> = []
  for (const range of parsed) {
    if (range.floor === 0) continue
    const rates = rateMap(range.prices)
    if (!rates) return null
    tiers.push({ minPromptTokens: range.floor, rates })
  }
  return compileTokenCard(baseRates, tiers, source)
}

function releasedAt(value: string | null | undefined): number | null {
  if (!value) return null
  const ms = Date.parse(value.replace(' ', 'T') + 'Z')
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000)
}

function listingSource(path: string): FactSource {
  return { derivation: 'listing', sourceUrl: MODELS_URL, path }
}

function unique(flags: Array<string>): Array<string> {
  return [...new Set(flags)]
}

export async function dashscopeListedModel(
  row: DashscopeListedModel,
): Promise<ModelInfo | null> {
  if (!row.model) return null
  const activity = dashscopeModelActivity(row)
  const capabilities = (row.features ?? []).flatMap(
    (feature) => FEATURES[feature] ?? [],
  )
  const input = modalityList(row.inference_metadata?.request_modality)
  const output = modalityList(row.inference_metadata?.response_modality)
  const info = row.model_info
  const maxFromOutput = info?.max_output_tokens ?? null
  const maxOutput = maxFromOutput ?? info?.reasoning_max_output_tokens ?? null
  const contextWindow = info?.context_window ?? null
  const chatFeatures = activity === 'chat' && Array.isArray(row.features)
  const model: ModelInfo = {
    rawId: row.model,
    displayName: row.name ?? null,
    activity,
    contextWindow,
    maxOutput,
    releasedAt: releasedAt(row.published_time),
    ...(input.length > 0 || output.length > 0
      ? { modalities: { input, output } }
      : {}),
    ...(chatFeatures || capabilities.length > 0
      ? { capabilities, ...(chatFeatures ? { exactCapabilities: true } : {}) }
      : {}),
  }
  const card = await dashscopeListedCard(row.prices)
  if (card) model.pricing = card
  const sources: ModelFactSources = {}
  if (contextWindow != null) {
    sources.contextWindow = listingSource('model_info.context_window')
  }
  if (maxOutput != null) {
    sources.maxOutput = listingSource(
      maxFromOutput != null
        ? 'model_info.max_output_tokens'
        : 'model_info.reasoning_max_output_tokens',
    )
  }
  if (model.modalities != null) {
    sources.modalities = listingSource('inference_metadata')
  }
  if (card) sources.pricing = listingSource('prices')
  if (capabilities.length > 0) {
    sources.capabilities = Object.fromEntries(
      capabilities.map((flag) => [flag, listingSource(`features.${flag}`)]),
    )
  }
  if (
    sources.contextWindow ||
    sources.maxOutput ||
    sources.modalities ||
    sources.pricing ||
    sources.capabilities
  ) {
    model.factSources = sources
  }
  return model
}

function withCompat(
  model: ModelInfo,
  compat: DashscopeCompatFacts | null,
): ModelInfo {
  if (model.activity !== 'chat') return model
  if (compat && !dashscopeCompatCovers(model.rawId, compat.scope)) return model
  if (!compat) {
    return {
      ...model,
      absent: { ...model.absent, requestMap: 'unavailable' },
    }
  }
  const prior = Array.isArray(model.capabilities) ? model.capabilities : []
  const flags = unique([
    ...prior.filter((flag): flag is string => typeof flag === 'string'),
    ...compat.flags,
  ])
  const compatSource = (flag: string): FactSource => ({
    derivation: 'docs-extracted',
    sourceUrl: DASHSCOPE_COMPAT_URL,
    sourceHash: compat.sourceHash,
    path: `parameters.${flag}`,
  })
  const sources: ModelFactSources = { ...model.factSources }
  sources.capabilities = {
    ...sources.capabilities,
    ...Object.fromEntries(
      compat.flags.map((flag) => [flag, compatSource(flag)]),
    ),
  }
  return {
    ...model,
    requestMap: compat.requestMap,
    capabilities: flags,
    exactCapabilities: true,
    factSources: sources,
  }
}

function needsModelPage(model: ModelInfo): boolean {
  return (
    model.activity === 'chat' &&
    (model.contextWindow == null || model.maxOutput == null)
  )
}

function applyModelLimits(
  model: ModelInfo,
  url: string,
  doc: DashscopeLimitsDoc | null,
): ModelInfo {
  if (!needsModelPage(model)) return model
  const limits = doc?.models[model.rawId]
  const next: ModelInfo = { ...model }
  const sources: ModelFactSources = { ...model.factSources }
  const absent = { ...model.absent }
  const source = (path: string): FactSource => ({
    derivation: 'docs-extracted',
    sourceUrl: url,
    ...(doc ? { sourceHash: doc.sourceHash } : {}),
    path,
  })
  if (model.contextWindow == null) {
    const value = limits?.contextWindow
    if (value != null) {
      next.contextWindow = value
      sources.contextWindow = source('Context limits.Context Window')
    } else if (!doc) {
      absent.contextWindow = 'unavailable'
    }
  }
  if (model.maxOutput == null) {
    const value = limits?.maxOutput
    if (value != null) {
      next.maxOutput = value
      sources.maxOutput = source('Context limits.Max Output')
    } else if (!doc) {
      absent.maxOutput = 'unavailable'
    }
  }
  if (
    sources.contextWindow ||
    sources.maxOutput ||
    sources.modalities ||
    sources.pricing ||
    sources.capabilities
  ) {
    next.factSources = sources
  }
  if (Object.keys(absent).length > 0) next.absent = absent
  return next
}

async function listModels(
  env: ProviderSecrets,
  kv?: KVNamespace,
): Promise<ListModelsResult> {
  const key = env.DASHSCOPE_API_KEY
  if (!key) {
    return { models: [], ...skippedResult('dashscope', 'DASHSCOPE_API_KEY') }
  }
  const run = docsRun()
  const listed: Array<ModelInfo> = []
  let page = 1
  let total = Infinity
  while (listed.length < total && page < 20) {
    const body = (await fetchJson(
      `${MODELS_URL}?page_no=${String(page)}&page_size=100&language=en-US`,
      { headers: { Authorization: `Bearer ${key}` } },
    )) as { output?: { total?: number; models?: Array<DashscopeListedModel> } }
    const batch = body.output?.models ?? []
    if (typeof body.output?.total === 'number') total = body.output.total
    if (batch.length === 0) break
    for (const row of batch) {
      const model = await dashscopeListedModel(row)
      if (model) listed.push(model)
    }
    page += 1
  }
  const compat = await tryDocs(run, DASHSCOPE_COMPAT_URL, (cached) =>
    cached(kv, DASHSCOPE_COMPAT_URL, async () =>
      parseDashscopeCompat(await fetchText(DASHSCOPE_COMPAT_URL, DOCS_INIT)),
    ),
  )
  const limitUrls = [
    ...new Set(
      listed
        .filter(needsModelPage)
        .map((model) => dashscopeModelPageUrl(model.rawId)),
    ),
  ]
  const limitDocs = new Map<string, DashscopeLimitsDoc | null>()
  for (const url of limitUrls) {
    limitDocs.set(
      url,
      await tryDocs(run, url, (cached) =>
        cached(kv, url, async () =>
          loadDashscopeModelLimits(await fetchText(url, DOCS_INIT)),
        ),
      ),
    )
  }
  return {
    models: listed.map((model) =>
      withCompat(
        needsModelPage(model)
          ? applyModelLimits(
              model,
              dashscopeModelPageUrl(model.rawId),
              limitDocs.get(dashscopeModelPageUrl(model.rawId)) ?? null,
            )
          : model,
        compat,
      ),
    ),
    docsFailures: docsReport(run),
  }
}

export const provider: ProviderConfig = {
  id: 'dashscope',
  displayName: 'Alibaba Cloud Model Studio',
  authEnvVar: 'DASHSCOPE_API_KEY',
  specSourceUrl: SPEC_SOURCE_URL,
  modelsEndpoint: MODELS_URL,
  defaultDerivation: 'generated',
  fetchSpec,
  listModels,
  classify: classifyOpenAiCompat,
  generationEndpointId: ({ rawId, activity }) => {
    if (activity === 'video') return null
    if (
      activity === 'chat' &&
      !dashscopeCompatCovers(
        rawId,
        parseDashscopeCompatScope(DASHSCOPE_COMPAT_SCOPE),
      )
    ) {
      return null
    }
    return compatGenerationEndpointId(
      activity,
      '',
      activity === 'audio' && /asr|transcri/i.test(rawId)
        ? 'transcriptions'
        : 'speech',
    )
  },
}
