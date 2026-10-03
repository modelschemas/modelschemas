/**
 * Chat catalogs TanStack AI reads from the public models.dev API
 * (https://models.dev/api.json). Listing does not call the provider, so
 * Bedrock and Vertex ship without AWS credentials or a service account.
 * Prices are the provider's own models.dev `cost` (USD per million tokens).
 * All-zero or incomplete costs stay null. Gateways are not filled from a
 * maker's card.
 */
import { compileTokenCard } from '@modelschemas/rate-card'
import type { RateCard, TokenRateTier } from '@modelschemas/rate-card'

import type { Activity } from '#/db/schema.ts'

import { endpointIdFromPath } from '../ingest/bundle.ts'
import { fetchText, sha256Text } from './types.ts'
import type {
  ListModelsResult,
  ModelInfo,
  ModelReasoning,
  OpenApiDocument,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from './types.ts'

export const MODELS_DEV_API_URL = 'https://models.dev/api.json'

/** models.dev `provider.npm` → OpenAPI path on that provider's server. */
const WIRE_PATH: Record<string, string> = {
  '@ai-sdk/openai': '/responses',
  '@ai-sdk/openai-compatible': '/chat/completions',
  '@ai-sdk/gateway': '/chat/completions',
  'ai-gateway-provider': '/chat/completions',
  '@ai-sdk/azure': '/openai/deployments/{deployment}/chat/completions',
  '@ai-sdk/anthropic': '/messages',
  '@ai-sdk/google': '/models/{model}:generateContent',
  '@ai-sdk/google-vertex': '/publishers/google/models/{model}:generateContent',
  '@ai-sdk/google-vertex/anthropic':
    '/publishers/anthropic/models/{model}:rawPredict',
  '@ai-sdk/amazon-bedrock': '/model/{modelId}/converse',
  /** Mantle is OpenAI-compatible, not Converse. */
  '@ai-sdk/amazon-bedrock/mantle': '/chat/completions',
}

const PER_MILLION = 1_000_000

const LEVERS: Record<string, string> = {
  input: 'input_tokens',
  output: 'output_tokens',
  cache_read: 'cache_read_tokens',
  cache_write: 'cache_write_tokens',
  input_audio: 'audio_tokens',
}

interface Catalog {
  hash: string
  providers: Record<string, ModelsDevProvider>
}

interface ModelsDevProvider {
  id?: string
  npm?: string
  name?: string
  models?: Record<string, unknown>
}

let catalogPromise: Promise<Catalog> | null = null

/** Test hook. The isolate otherwise reuses one download across providers. */
export function clearModelsDevCatalogCache(): void {
  catalogPromise = null
}

async function loadCatalog(): Promise<Catalog> {
  if (!catalogPromise) {
    catalogPromise = fetchText(MODELS_DEV_API_URL)
      .then(async (text) => {
        const parsed: unknown = JSON.parse(text)
        if (!isRecord(parsed)) {
          throw new Error('models.dev: api.json is not an object')
        }
        return {
          hash: await sha256Text(text),
          providers: parsed as Record<string, ModelsDevProvider>,
        }
      })
      .catch((error: unknown) => {
        catalogPromise = null
        throw error
      })
  }
  return catalogPromise
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : null
}

/** Chat rows emit text. Image, video, and audio-only rows are not chat. */
export function modelsDevChatOutput(entry: unknown): boolean {
  if (!isRecord(entry) || !isRecord(entry.modalities)) return false
  const output = entry.modalities.output
  return Array.isArray(output) && output.includes('text')
}

export function modelsDevWirePath(npm: string | undefined): string | null {
  if (!npm) return null
  return WIRE_PATH[npm] ?? null
}

function stringList(value: unknown): Array<string> | null {
  if (!Array.isArray(value)) return null
  const out: Array<string> = []
  for (const item of value) {
    if (typeof item !== 'string') return null
    out.push(item)
  }
  return out
}

/**
 * Published reasoning control. Effort wins when models.dev lists it beside
 * a token budget. A toggle means reasoning can be turned off. `reasoning:
 * true` with no control is adaptive and mandatory — no off switch is published.
 */
export function modelsDevReasoning(
  entry: Record<string, unknown>,
): ModelReasoning | null {
  if (entry.reasoning !== true) return null
  const options = Array.isArray(entry.reasoning_options)
    ? entry.reasoning_options.filter(isRecord)
    : []
  const toggle = options.some((option) => option.type === 'toggle')
  const effort = options.find((option) => option.type === 'effort')
  const efforts = effort ? stringList(effort.values) : null
  if (efforts && efforts.length > 0) {
    return {
      mode: 'effort',
      mandatory:
        !toggle && !efforts.includes('none') && !efforts.includes('off'),
      efforts,
    }
  }
  if (options.some((option) => option.type === 'budget_tokens')) {
    return { mode: 'budget', mandatory: !toggle }
  }
  return { mode: 'adaptive', mandatory: !toggle }
}

function perToken(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null
  }
  return value / PER_MILLION
}

function leverRates(
  cost: Record<string, unknown>,
): Record<string, number> | null {
  const rates: Record<string, number> = {}
  for (const [key, lever] of Object.entries(LEVERS)) {
    if (!(key in cost)) continue
    const rate = perToken(cost[key])
    if (rate === null) return null
    rates[lever] = rate
  }
  if (!('input_tokens' in rates) || !('output_tokens' in rates)) return null
  return rates
}

function contextTier(
  entry: unknown,
): { size: number; rates: Record<string, number> } | null {
  if (!isRecord(entry) || !isRecord(entry.tier)) return null
  if (entry.tier.type !== 'context') return null
  const size = positive(entry.tier.size)
  const rates = leverRates(entry)
  if (size === null || !rates) return null
  return { size, rates }
}

/** Provider `cost` object → token card. Null when unpublished or unusable. */
export function modelsDevRateCard(
  cost: unknown,
  source: RateCard['source'],
): RateCard | null {
  if (!isRecord(cost)) return null
  const base = leverRates(cost)
  if (!base) return null
  const tiers: Array<TokenRateTier> = []
  const listed = Array.isArray(cost.tiers) ? cost.tiers : []
  for (const tier of listed) {
    const parsed = contextTier(tier)
    if (!parsed) continue
    tiers.push({
      minPromptTokens: parsed.size,
      rates: { ...base, ...parsed.rates },
    })
  }
  if (tiers.length === 0 && isRecord(cost.context_over_200k)) {
    const over = leverRates(cost.context_over_200k)
    if (over) {
      tiers.push({
        minPromptTokens: 200_000,
        rates: { ...base, ...over },
      })
    }
  }
  return compileTokenCard(base, tiers, source)
}

function modalities(entry: Record<string, unknown>): ModelInfo['modalities'] {
  if (!isRecord(entry.modalities)) return null
  const input = stringList(entry.modalities.input)
  const output = stringList(entry.modalities.output)
  if (!input || !output) return null
  return { input, output }
}

function capabilities(entry: Record<string, unknown>): Array<string> | null {
  const caps: Array<string> = []
  if (entry.tool_call === true) caps.push('tools')
  if (entry.structured_output === true) caps.push('structured_outputs')
  if (entry.temperature === true) caps.push('temperature')
  return caps.length > 0 ? caps : null
}

function releasedAt(entry: Record<string, unknown>): number | null {
  if (typeof entry.release_date !== 'string') return null
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(entry.release_date)
  if (!match) return null
  return (
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 1000
  )
}

/**
 * One models.dev model row → a chat catalog row, or null when it does not
 * emit text. `npmFallback` is the provider package; a row may override it
 * with `provider.npm` (OpenCode Claude vs GPT).
 */
export function normalizeModelsDevChat(
  entry: unknown,
  npmFallback: string | undefined,
  source: RateCard['source'],
): ModelInfo | null {
  if (!isRecord(entry) || typeof entry.id !== 'string' || entry.id === '') {
    return null
  }
  if (!modelsDevChatOutput(entry)) return null
  const rowNpm =
    isRecord(entry.provider) && typeof entry.provider.npm === 'string'
      ? entry.provider.npm
      : npmFallback
  const path = modelsDevWirePath(rowNpm)
  const limit = isRecord(entry.limit) ? entry.limit : {}
  return {
    rawId: entry.id,
    displayName: typeof entry.name === 'string' ? entry.name : null,
    activity: 'chat',
    contextWindow: positive(limit.context),
    maxOutput: positive(limit.output),
    modalities: modalities(entry),
    pricing: modelsDevRateCard(entry.cost, source),
    capabilities: capabilities(entry),
    reasoning: modelsDevReasoning(entry),
    schemaEndpointId: path ? endpointIdFromPath(path) : null,
    releasedAt: releasedAt(entry),
  }
}

function providerRecord(
  catalog: Catalog,
  providerId: string,
): ModelsDevProvider {
  const provider = catalog.providers[providerId]
  if (!provider || !isRecord(provider.models)) {
    throw new Error(`models.dev: provider "${providerId}" has no models`)
  }
  return provider
}

export async function listModelsDevChat(
  providerId: string,
): Promise<ListModelsResult> {
  const catalog = await loadCatalog()
  const provider = providerRecord(catalog, providerId)
  const source: RateCard['source'] = {
    url: MODELS_DEV_API_URL,
    hash: catalog.hash,
    extractedAt: new Date().toISOString(),
  }
  const models: Array<ModelInfo> = []
  for (const entry of Object.values(provider.models ?? {})) {
    const normalized = normalizeModelsDevChat(entry, provider.npm, source)
    if (normalized) models.push(normalized)
  }
  if (models.length === 0) {
    throw new Error(`models.dev: provider "${providerId}" has no chat models`)
  }
  return { models }
}

function chatOperation(
  path: string,
  summary: string,
): NonNullable<OpenApiDocument['paths']> {
  const body = {
    type: 'object',
    properties: {
      model: { type: 'string' },
      messages: { type: 'array' },
    },
  }
  return {
    [path]: {
      post: {
        summary,
        requestBody: {
          content: { 'application/json': { schema: body } },
        },
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { id: { type: 'string' } },
                },
              },
            },
          },
        },
      },
    },
  }
}

/** Docs-derived chat routes for the wires this provider's rows name. */
export async function fetchModelsDevSpec(
  providerId: string,
  displayName: string,
  serverUrl: string,
): Promise<SpecFetchResult> {
  const catalog = await loadCatalog()
  const provider = providerRecord(catalog, providerId)
  const paths: NonNullable<OpenApiDocument['paths']> = {}
  for (const entry of Object.values(provider.models ?? {})) {
    if (!isRecord(entry) || !modelsDevChatOutput(entry)) continue
    const rowNpm =
      isRecord(entry.provider) && typeof entry.provider.npm === 'string'
        ? entry.provider.npm
        : provider.npm
    const path = modelsDevWirePath(rowNpm)
    if (!path || paths[path]) continue
    Object.assign(
      paths,
      chatOperation(path, `${displayName} chat (${rowNpm ?? 'unknown wire'})`),
    )
  }
  const spec: OpenApiDocument = {
    openapi: '3.1.0',
    info: { title: displayName, version: 'models.dev' },
    servers: [{ url: serverUrl }],
    paths,
  }
  return {
    specs: [spec],
    sources: [{ url: MODELS_DEV_API_URL, hash: catalog.hash }],
    outputStrategy: 'post-200',
  }
}

export function classifyModelsDevPath(path: string): Activity | null {
  const known = new Set(Object.values(WIRE_PATH))
  return known.has(path) ? 'chat' : null
}

export interface ModelsDevChatProviderDef {
  id: string
  displayName: string
  /** Data-plane origin written onto the generated spec. Not fetched. */
  serverUrl: string
  docUrl: string
}

/** One models.dev provider as a modelschemas adapter. */
export function modelsDevChatProvider(
  def: ModelsDevChatProviderDef,
): ProviderConfig {
  return {
    id: def.id,
    displayName: def.displayName,
    specSourceUrl: def.docUrl,
    modelsEndpoint: MODELS_DEV_API_URL,
    defaultDerivation: 'docs-derived',
    fetchSpec: (_env: ProviderSecrets) =>
      fetchModelsDevSpec(def.id, def.displayName, def.serverUrl),
    listModels: () => listModelsDevChat(def.id),
    classify: classifyModelsDevPath,
  }
}
