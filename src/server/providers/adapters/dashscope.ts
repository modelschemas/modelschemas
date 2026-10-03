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
  classifyOpenAiCompat,
  fetchOpenAiCompatibleSpec,
} from '../openai-compat.ts'
import type { OpenAiCompatPath } from '../openai-compat.ts'
import {
  compatGenerationEndpointId,
  dashscopeModelActivity,
} from '../model-meta.ts'
import { fetchJson, sha256Text, skippedResult } from '../types.ts'
import type {
  ListModelsResult,
  ModelInfo,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

const SPEC_SOURCE_URL =
  'https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope'
const MODELS_URL = 'https://dashscope-intl.aliyuncs.com/api/v1/models'
const SERVER_URL = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'

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
  input_token_cache_creation_5m: 'cache_write_tokens',
  input_token_cache_creation_1h: 'cache_write_1h_tokens',
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
  }
}

function modalityList(values: Array<string> | undefined): Array<string> {
  return (values ?? []).map((value) => value.toLowerCase())
}

/** `Default` and a 0 floor are the base. `32k<…` starts above 32k tokens. */
function promptFloor(range: string): number | null {
  if (range === '' || range === 'Default') return 0
  if (/^0\s*</.test(range)) return 0
  const kilo = range.match(/(\d+(?:\.\d+)?)\s*k\s*</i)
  if (kilo?.[1]) return Number(kilo[1]) * 1000
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

/**
 * Token ranges become a token card. A per-image quote becomes a unit card.
 * An unparsed range, a mixed unit, or an all-zero quote stays null.
 * Explicit cache read is omitted when implicit cache is also quoted.
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
  if ([...units].some((unit) => !/per 1m tokens/i.test(unit))) return null

  const rateMap = (
    prices: Array<DashscopePrice>,
  ): Record<string, number> | null => {
    const rates: Record<string, number> = {}
    const hasImplicit = prices.some(
      (price) => price.type === 'input_token_cache',
    )
    for (const price of prices) {
      if (hasImplicit && price.type === 'input_token_cache_read') continue
      const lever = price.type ? TOKEN_LEVERS[price.type] : undefined
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
  const model: ModelInfo = {
    rawId: row.model,
    displayName: row.name ?? null,
    activity,
    contextWindow: row.model_info?.context_window ?? null,
    maxOutput: row.model_info?.max_output_tokens ?? null,
    releasedAt: releasedAt(row.published_time),
    ...(input.length > 0 || output.length > 0
      ? { modalities: { input, output } }
      : {}),
    ...(capabilities.length > 0 ? { capabilities } : {}),
  }
  const card = await dashscopeListedCard(row.prices)
  if (card) model.pricing = card
  return model
}

async function listModels(env: ProviderSecrets): Promise<ListModelsResult> {
  const key = env.DASHSCOPE_API_KEY
  if (!key) {
    return { models: [], ...skippedResult('dashscope', 'DASHSCOPE_API_KEY') }
  }
  const models: Array<ModelInfo> = []
  let page = 1
  let total = Infinity
  while (models.length < total && page < 20) {
    const body = (await fetchJson(
      `${MODELS_URL}?page_no=${String(page)}&page_size=100&language=en-US`,
      { headers: { Authorization: `Bearer ${key}` } },
    )) as { output?: { total?: number; models?: Array<DashscopeListedModel> } }
    const batch = body.output?.models ?? []
    if (typeof body.output?.total === 'number') total = body.output.total
    if (batch.length === 0) break
    for (const row of batch) {
      const model = await dashscopeListedModel(row)
      if (model) models.push(model)
    }
    page += 1
  }
  return { models }
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
    return compatGenerationEndpointId(
      activity,
      '',
      activity === 'audio' && /asr|transcri/i.test(rawId)
        ? 'transcriptions'
        : 'speech',
    )
  },
}
