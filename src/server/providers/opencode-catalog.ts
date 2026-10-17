/** OpenCode owns models.dev. Only its two providers may read these facts. */
import { compileTokenCard } from '@modelschemas/rate-card'
import type { RateCard, TokenRateTier } from '@modelschemas/rate-card'

import { cachedDocs } from './model-facts.ts'
import type { ChatRequestMap } from './request-map.ts'
import { fetchText, sha256Text } from './types.ts'
import type {
  FactSource,
  ModelFactSources,
  ModelInfo,
  ModelReasoning,
} from './types.ts'

export const OPENCODE_CATALOG_URL = 'https://models.dev/api.json'
type OpenCodeProvider = 'opencode' | 'opencode-go'

/** Path under the provider's `/v1` base. A package this map does not name has no route. */
const PACKAGE_SUFFIX: Record<string, (id: string) => string> = {
  '@ai-sdk/anthropic': () => 'messages',
  '@ai-sdk/openai': () => 'responses',
  '@ai-sdk/google': (id) => `models/${id}`,
  '@ai-sdk/openai-compatible': () => 'chat/completions',
}

const COST_LEVERS: Record<string, string> = {
  input: 'input_tokens',
  output: 'output_tokens',
  cache_read: 'cache_read_tokens',
  cache_write: 'cache_write_tokens',
  reasoning: 'reasoning_tokens',
  input_audio: 'audio_tokens',
  output_audio: 'audio_output_tokens',
}

export interface OpenCodeCatalogLoad {
  payload: unknown
  hash: string
  extractedAt: string
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function strings(value: unknown): value is Array<string> {
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
}
function reasoning(value: unknown): ModelReasoning | null {
  if (value === undefined) return null
  if (!Array.isArray(value))
    throw new Error('opencode: unreadable reasoning_options')
  const options = value.map((option: unknown) => {
    if (
      !record(option) ||
      !['toggle', 'effort', 'budget_tokens'].includes(String(option.type))
    ) {
      throw new Error('opencode: unreadable reasoning option')
    }
    if (
      option.type === 'effort' &&
      (!strings(option.values) || option.values.length === 0)
    ) {
      throw new Error('opencode: unreadable effort values')
    }
    return option
  })
  const toggle = options.some((option) => option.type === 'toggle')
  const effort = options.find((option) => option.type === 'effort')
  if (effort && strings(effort.values))
    return {
      mode: 'effort',
      efforts: effort.values,
      mandatory:
        toggle ||
        effort.values.some((v) => ['none', 'off', 'disabled'].includes(v))
          ? false
          : null,
    }
  if (options.some((option) => option.type === 'budget_tokens'))
    return { mode: 'budget', mandatory: toggle ? false : null }
  return toggle ? { mode: 'toggle', mandatory: false } : null
}

/** USD per million tokens → USD per token. Throws on a shape a card must not invent. */
function perToken(
  cost: Record<string, unknown>,
  id: string,
  allowTier: boolean,
): Record<string, number> {
  const rates: Record<string, number> = {}
  for (const [key, value] of Object.entries(cost)) {
    if (allowTier && key === 'tier') continue
    const lever = COST_LEVERS[key]
    if (!lever) throw new Error(`opencode: unreadable cost.${key} for ${id}`)
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(`opencode: unreadable cost.${key} for ${id}`)
    }
    rates[lever] = value / 1e6
  }
  if (rates.input_tokens === undefined || rates.output_tokens === undefined) {
    throw new Error(`opencode: cost for ${id} omits input or output`)
  }
  return rates
}

function sameRates(a: Record<string, number>, b: Record<string, number>) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of keys) if (a[key] !== b[key]) return false
  return true
}

/**
 * Zen `cost`, including context `tiers`. `context_over_200k` is a copy of
 * one tier's rates (its name is not the threshold when the tier size is
 * 272K); a copy that matches no tier is unreadable. All-zero quotes are a
 * sourced free card. Go does not call this: its `cost` is not a billed price.
 */
export function compileOpenCodeCost(
  cost: unknown,
  id: string,
  source: RateCard['source'],
): RateCard {
  if (!record(cost)) throw new Error(`opencode: unreadable cost for ${id}`)
  const { tiers: rawTiers, context_over_200k: legacy, ...baseCost } = cost
  const base = perToken(baseCost, id, false)
  const tiers: Array<TokenRateTier> = []
  if (rawTiers !== undefined) {
    if (!Array.isArray(rawTiers)) {
      throw new Error(`opencode: unreadable cost.tiers for ${id}`)
    }
    const seen = new Set<number>()
    for (const tier of rawTiers) {
      if (!record(tier) || !record(tier.tier)) {
        throw new Error(`opencode: unreadable cost tier for ${id}`)
      }
      if (tier.tier.type !== 'context') {
        throw new Error(`opencode: unreadable cost tier for ${id}`)
      }
      const size = tier.tier.size
      if (
        typeof size !== 'number' ||
        !Number.isSafeInteger(size) ||
        size <= 0
      ) {
        throw new Error(`opencode: unreadable cost tier for ${id}`)
      }
      if (seen.has(size)) {
        throw new Error(`opencode: duplicate cost tier for ${id}`)
      }
      seen.add(size)
      const rates = perToken(tier, id, true)
      if (Object.keys(base).some((lever) => !(lever in rates))) {
        throw new Error(`opencode: cost tier for ${id} omits a base rate`)
      }
      tiers.push({ minPromptTokens: size, rates })
    }
  }
  if (legacy !== undefined) {
    if (!record(legacy)) {
      throw new Error(`opencode: unreadable context_over_200k for ${id}`)
    }
    const rates = perToken(legacy, id, false)
    const copied = tiers.some((tier) => sameRates(tier.rates, rates))
    if (!copied) {
      throw new Error(
        `opencode: context_over_200k disagrees with cost tiers for ${id}`,
      )
    }
  }
  if (
    Object.values(base).every((rate) => rate === 0) &&
    tiers.every((tier) => Object.values(tier.rates).every((rate) => rate === 0))
  ) {
    if (tiers.length > 0) {
      throw new Error(`opencode: zero base rate with a tier for ${id}`)
    }
    return {
      inputs: Object.fromEntries(
        Object.keys(base).map((lever) => [
          lever,
          {
            param: lever,
            bound: 'usage',
            kind: 'number',
            ...(!['input_tokens', 'output_tokens'].includes(lever)
              ? { default: 0 }
              : {}),
          },
        ]),
      ),
      tables: { rate: { base } },
      price: 0,
      examples: [],
      source,
    }
  }
  if (Object.values(base).every((rate) => rate === 0) && tiers.length > 0) {
    throw new Error(`opencode: zero base rate with a priced tier for ${id}`)
  }
  const audio = ['audio_tokens', 'audio_output_tokens'].filter(
    (lever) => lever in base || tiers.some((tier) => lever in tier.rates),
  )
  const card = compileTokenCard(
    base,
    tiers,
    source,
    audio.length > 0 ? { extraPromptLevers: audio } : undefined,
  )
  if (!card) throw new Error(`opencode: unreadable cost for ${id}`)
  return card
}

/** Zen's base path under opencode.ai, from a provider or model `api`. */
function openCodeApiPath(api: string): string {
  const url = new URL(api)
  const path = url.pathname.replace(/^\//, '').replace(/\/$/, '')
  if (url.origin !== 'https://opencode.ai' || path.length === 0) {
    throw new Error('opencode: models.dev api is not an opencode.ai path')
  }
  return path
}

/** Path under the host. Zen follows the model's models.dev `api`, else the provider's; Go stays on the documented `/zen/go/v1` ids. */
function schemaEndpointId(
  provider: OpenCodeProvider,
  apiPath: string | null,
  npm: string,
  id: string,
): string | null {
  const suffix = PACKAGE_SUFFIX[npm]?.(id) ?? null
  if (!suffix) return null
  // routes/zen/go/v1 has no models/[model].ts (/zen/go/v1/models/{id} is a
  // 404). Bind Go Gemini rows again if the Go tree adds one.
  if (provider === 'opencode-go' && npm === '@ai-sdk/google') return null
  if (id.includes('/'))
    throw new Error(`${provider}: unreadable model id ${id}`)
  // Go's console page still publishes https://opencode.ai/zen/go/v1, and that
  // host serves the same listing as models.dev's /inference/go/v1. Keep the
  // ids already stored (`v1/...`) until the documented base is the one to move.
  return provider === 'opencode' ? `${apiPath}/${suffix}` : `v1/${suffix}`
}

export function parseOpenCodeCatalog(
  payload: unknown,
  provider: OpenCodeProvider,
  hash: string,
  extractedAt?: string,
): Record<string, ModelInfo> {
  if (!record(payload) || !record(payload[provider])) {
    throw new Error(`${provider}: models.dev has no provider models object`)
  }
  const block = payload[provider]
  const models = block.models
  if (!record(models)) {
    throw new Error(`${provider}: models.dev has no provider models object`)
  }
  if (typeof block.npm !== 'string' || block.npm.length === 0) {
    throw new Error(`${provider}: models.dev provider npm is missing`)
  }
  let apiPath: string | null = null
  if (provider === 'opencode') {
    if (typeof block.api !== 'string') {
      throw new Error('opencode: models.dev api is missing')
    }
    apiPath = openCodeApiPath(block.api)
  }
  const out: Record<string, ModelInfo> = {}
  for (const [id, row] of Object.entries(models)) {
    if (!record(row) || row.id !== id)
      throw new Error(`${provider}: unreadable catalog model ${id}`)
    const source = (path: string): FactSource => ({
      derivation: 'listing',
      sourceUrl: OPENCODE_CATALOG_URL,
      sourceHash: hash,
      path: `${provider}.models.${id}.${path}`,
    })
    const factSources: ModelFactSources = {}
    const model: ModelInfo = {
      rawId: id,
      releasedAt: null,
      knowledgeCutoff: null,
      openWeights: null,
      contextWindow: null,
      maxOutput: null,
      modalities: null,
      capabilities: null,
      reasoning: reasoning(row.reasoning_options),
      requestMap: null,
      providerMetadata: row,
    }
    if (row.name !== undefined) {
      if (typeof row.name !== 'string' || row.name.length === 0) {
        throw new Error(`${provider}: unreadable name for ${id}`)
      }
      model.displayName = row.name
    }
    let modelNpm: string | null = null
    let modelApiPath = apiPath
    if (row.provider !== undefined) {
      if (!record(row.provider)) {
        throw new Error(`${provider}: unreadable provider for ${id}`)
      }
      if (row.provider.npm !== undefined) {
        if (
          typeof row.provider.npm !== 'string' ||
          row.provider.npm.length === 0
        ) {
          throw new Error(`${provider}: unreadable provider.npm for ${id}`)
        }
        modelNpm = row.provider.npm
      }
      if (provider === 'opencode' && row.provider.api !== undefined) {
        if (typeof row.provider.api !== 'string') {
          throw new Error(`opencode: unreadable provider.api for ${id}`)
        }
        modelApiPath = openCodeApiPath(row.provider.api)
      }
    }
    const npm = modelNpm ?? block.npm
    const endpoint = schemaEndpointId(provider, modelApiPath, npm, id)
    if (endpoint) {
      model.schemaEndpointId = endpoint
      model.activity = 'chat'
      factSources.schemaEndpointId = {
        derivation: 'listing',
        sourceUrl: OPENCODE_CATALOG_URL,
        sourceHash: hash,
        // The route is the package's path, not an endpoint stated on the model.
        path: modelNpm
          ? `${provider}.models.${id}.provider.npm`
          : `${provider}.npm`,
      }
    } else if (PACKAGE_SUFFIX[npm]) {
      model.activity = 'chat'
    }
    if (provider === 'opencode' && row.cost !== undefined) {
      if (!extractedAt)
        throw new Error('opencode: catalog extractedAt is missing')
      model.pricing = compileOpenCodeCost(row.cost, id, {
        url: OPENCODE_CATALOG_URL,
        hash,
        extractedAt,
      })
      factSources.pricing = {
        derivation: 'listing',
        sourceUrl: OPENCODE_CATALOG_URL,
        sourceHash: hash,
        path: `${provider}.models.${id}.cost`,
      }
    }
    if (row.release_date !== undefined) {
      if (
        typeof row.release_date !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(row.release_date)
      )
        throw new Error(`${provider}: unreadable release_date for ${id}`)
      const timestamp = Date.parse(`${row.release_date}T00:00:00.000Z`)
      if (
        !Number.isFinite(timestamp) ||
        new Date(timestamp).toISOString().slice(0, 10) !== row.release_date
      )
        throw new Error(`${provider}: unreadable release_date for ${id}`)
      model.releasedAt = timestamp / 1000
    }
    if (row.knowledge !== undefined) {
      if (
        typeof row.knowledge !== 'string' ||
        !/^\d{4}-(0[1-9]|1[0-2])(?:-\d{2})?$/.test(row.knowledge)
      )
        throw new Error(`${provider}: unreadable knowledge for ${id}`)
      if (row.knowledge.length === 10) {
        const timestamp = Date.parse(`${row.knowledge}T00:00:00.000Z`)
        if (
          !Number.isFinite(timestamp) ||
          new Date(timestamp).toISOString().slice(0, 10) !== row.knowledge
        )
          throw new Error(`${provider}: unreadable knowledge for ${id}`)
      }
      model.knowledgeCutoff = row.knowledge
      factSources.knowledgeCutoff = source('knowledge')
    }
    if (row.open_weights !== undefined) {
      if (typeof row.open_weights !== 'boolean')
        throw new Error(`${provider}: unreadable open_weights for ${id}`)
      model.openWeights = row.open_weights
      factSources.openWeights = source('open_weights')
    }
    if (row.limit !== undefined) {
      if (!record(row.limit))
        throw new Error(`${provider}: unreadable limits for ${id}`)
      for (const [key, fact] of [
        ['context', 'contextWindow'],
        ['output', 'maxOutput'],
      ] as const) {
        const value = row.limit[key]
        if (value === undefined) continue
        if (
          typeof value !== 'number' ||
          !Number.isSafeInteger(value) ||
          value <= 0
        )
          throw new Error(`${provider}: unreadable ${key} limit for ${id}`)
        model[fact] = value
        factSources[fact] = source(`limit.${key}`)
      }
    }
    if (row.modalities !== undefined) {
      if (
        !record(row.modalities) ||
        !strings(row.modalities.input) ||
        !strings(row.modalities.output)
      )
        throw new Error(`${provider}: unreadable modalities for ${id}`)
      model.modalities = row.modalities
      factSources.modalities = source('modalities')
    }
    const capabilities: Record<string, boolean> = {}
    const sources: Record<string, FactSource> = {}
    for (const [field, flag] of [
      ['tool_call', 'tools'],
      ['reasoning', 'reasoning'],
      ['structured_output', 'structured_outputs'],
    ] as const) {
      if (row[field] === undefined) continue
      if (typeof row[field] !== 'boolean')
        throw new Error(`${provider}: unreadable ${field} for ${id}`)
      capabilities[flag] = row[field]
      sources[flag] = source(field)
    }
    if (record(row.modalities) && strings(row.modalities.input)) {
      capabilities.vision = row.modalities.input.includes('image')
      sources.vision = source('modalities.input')
    }
    if (Object.keys(capabilities).length) {
      model.capabilities = capabilities
      factSources.capabilities = sources
    }
    if (model.reasoning) factSources.reasoning = source('reasoning_options')
    if (
      row.interleaved !== undefined &&
      typeof row.interleaved !== 'boolean' &&
      (!record(row.interleaved) || typeof row.interleaved.field !== 'string')
    )
      throw new Error(`${provider}: unreadable interleaved for ${id}`)
    if (
      record(row.interleaved) &&
      row.interleaved.field === 'reasoning_content'
    ) {
      const map: ChatRequestMap = {
        thinking: null,
        maxTokensField: null,
        developerRole: null,
        replayReasoningContent: true,
        store: null,
        strictTools: null,
        sessionAffinity: null,
        cacheControl: null,
        toolStream: null,
        reasoningEffort: null,
      }
      model.requestMap = map
      factSources.requestMap = source('interleaved.field')
    }
    model.factSources = factSources
    out[id] = model
  }
  if (!Object.keys(out).length)
    throw new Error(`${provider}: models.dev listed no models`)
  return out
}

export async function loadOpenCodeCatalog(
  kv?: KVNamespace,
): Promise<OpenCodeCatalogLoad> {
  // A v31 entry is `{payload, hash}` with no `extractedAt`. Reading it
  // throws on every Zen price until the TTL. This key misses that entry.
  return cachedDocs(kv, `${OPENCODE_CATALOG_URL}#extracted-at`, async () => {
    const text = await fetchText(OPENCODE_CATALOG_URL, {
      signal: AbortSignal.timeout(30_000),
    })
    return {
      payload: JSON.parse(text) as unknown,
      hash: await sha256Text(text),
      extractedAt: new Date().toISOString(),
    }
  })
}

export async function openCodeCatalog(
  provider: OpenCodeProvider,
  kv?: KVNamespace,
): Promise<Record<string, ModelInfo>> {
  const catalog = await loadOpenCodeCatalog(kv)
  return parseOpenCodeCatalog(
    catalog.payload,
    provider,
    catalog.hash,
    catalog.extractedAt,
  )
}
