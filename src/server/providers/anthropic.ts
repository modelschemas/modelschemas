/**
 * Anthropic — official OpenAPI spec bundled in Anthropic's Stainless-generated
 * TypeScript SDK (`scripts/mock-spec.json.gz`, refreshed on every SDK
 * codegen). `.stats.yml` stopped carrying `openapi_spec_url` on 2026-09-03.
 */
import type { Activity } from '#/db/schema.ts'
import {
  ANTHROPIC_THINKING_URL,
  anthropicModelFeatures,
  anthropicServerTools,
} from './anthropic-features.ts'
import { docsReport, docsRun, tryDocs, unavailable } from './model-facts.ts'
import {
  ANTHROPIC_MODELS_OVERVIEW_URL,
  anthropicAliasMap,
  applyDocumentedAliases,
} from './provider-aliases.ts'
import type { AnthropicThinkingCaps } from './anthropic-features.ts'
import {
  ANTHROPIC_PRICING_URL,
  anthropicModelPricing,
} from './anthropic-pricing.ts'
import { isoToEpochSeconds } from './release-dates.ts'
import { fetchJson, parseGzippedOpenApi, skippedResult } from './types.ts'
import { headerApiKeyConnect } from './connect.ts'
import { usEgressFetch } from './us-egress.ts'
import type {
  ListModelsResult,
  ModelFact,
  ProviderConfig,
  ProviderEnvironment,
  ProviderSecrets,
  SpecFetchResult,
} from './types.ts'

export const ANTHROPIC_SPEC_URL =
  'https://raw.githubusercontent.com/anthropics/anthropic-sdk-typescript/main/scripts/mock-spec.json.gz'
const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models'
const ANTHROPIC_VERSION = '2023-06-01'

/**
 * Anthropic's generation surface is messages + the legacy text completion
 * (plus `?beta=true` variants and token counting). Batches, files, skills,
 * and the agent-platform surfaces are platform endpoints.
 */
function classify(path: string): Activity | null {
  const bare = path.replace(/\?beta=true$/, '')
  if (bare.startsWith('/v1/messages/batches')) return null
  if (bare === '/v1/messages' || bare === '/v1/messages/count_tokens') {
    return 'chat'
  }
  if (bare === '/v1/complete') return 'chat'
  return null
}

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const response = await fetch(ANTHROPIC_SPEC_URL)
  if (!response.ok) {
    throw new Error(
      `fetch failed: ${ANTHROPIC_SPEC_URL} → ${String(response.status)} ${response.statusText}`,
    )
  }
  return parseGzippedOpenApi(
    new Uint8Array(await response.arrayBuffer()),
    'anthropic',
    ANTHROPIC_SPEC_URL,
  )
}

interface Supported {
  supported?: boolean
}

interface AnthropicModel {
  id: string
  display_name?: string
  created_at?: string
  max_input_tokens?: number
  max_tokens?: number
  capabilities?: {
    image_input?: Supported
    pdf_input?: Supported
    structured_outputs?: Supported
  } & AnthropicThinkingCaps
}

interface AnthropicModelList {
  data?: Array<AnthropicModel>
  has_more?: boolean
  last_id?: string
}

/**
 * Request features the Models API capability tree states. The tree does
 * not cover tool use, sampling params, or whether thinking can be turned
 * off (Fable/Mythos) — those live in prose docs and stay unset here.
 */
export function anthropicCapabilities(m: AnthropicModel): Array<string> | null {
  const caps = m.capabilities
  const out: Array<string> = []
  if (caps?.thinking?.supported) out.push('reasoning')
  if (caps?.effort?.supported) out.push('reasoning_effort')
  if (caps?.structured_outputs?.supported) {
    out.push('structured_outputs', 'response_format')
  }
  return out.length > 0 ? out : null
}

async function listModels(
  env: ProviderEnvironment,
  kv?: KVNamespace,
): Promise<ListModelsResult> {
  const key = env.ANTHROPIC_API_KEY
  if (!key) {
    return { models: [], ...skippedResult('anthropic', 'ANTHROPIC_API_KEY') }
  }
  const headers = { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION }
  // The docs host serves a page with no tables to the regions the API
  // refuses, so docs loads leave from the same place as the listing (#482).
  const egress = usEgressFetch(env)
  // A failed docs load leaves the facts it feeds unavailable on every row;
  // the Models API listing itself is never wrapped.
  const docs = docsRun()
  const [pricing, features, aliasMap] = await Promise.all([
    tryDocs(docs, ANTHROPIC_PRICING_URL, (cached) =>
      anthropicModelPricing(kv, cached, egress),
    ),
    tryDocs(docs, ANTHROPIC_THINKING_URL, (cached) =>
      anthropicModelFeatures(kv, cached, egress),
    ),
    tryDocs(docs, ANTHROPIC_MODELS_OVERVIEW_URL, (cached) =>
      anthropicAliasMap(kv, cached, egress),
    ),
  ])
  const lost: Array<ModelFact> = [
    ...(pricing ? [] : ['pricing' as const]),
    ...(features ? [] : ['reasoning' as const]),
    ...(aliasMap ? [] : ['aliases' as const]),
  ]
  const models: ListModelsResult['models'] = []
  let afterId: string | undefined
  do {
    const url = new URL(ANTHROPIC_MODELS_URL)
    url.searchParams.set('limit', '100')
    if (afterId) url.searchParams.set('after_id', afterId)
    const body = (await fetchJson(
      url.toString(),
      { headers },
      egress,
    )) as AnthropicModelList
    for (const m of body.data ?? []) {
      const input = ['text']
      if (m.capabilities?.image_input?.supported) input.push('image')
      if (m.capabilities?.pdf_input?.supported) input.push('file')
      const priced = pricing?.(m.display_name) ?? {}
      // Server tools come from the hand-written table, not the docs load.
      const feat = features?.(m.id, m.display_name, m.capabilities) ?? {
        reasoning: null,
        ...toolsOnly(m.id),
      }
      models.push({
        rawId: m.id,
        displayName: m.display_name ?? null,
        activity: 'chat',
        releasedAt: isoToEpochSeconds(m.created_at),
        // Models API (since 2026-03) carries limits + a capability tree.
        contextWindow: m.max_input_tokens ?? null,
        maxOutput: m.max_tokens ?? null,
        modalities: m.capabilities ? { input, output: ['text'] } : null,
        capabilities: m.capabilities ? anthropicCapabilities(m) : null,
        pricing: priced.pricing,
        reasoning: feat.reasoning,
        serverTools: feat.serverTools,
        factSources: { ...priced.factSources, ...feat.factSources },
        ...(lost.length > 0 ? unavailable(...lost) : {}),
      })
    }
    afterId = body.has_more ? body.last_id : undefined
  } while (afterId)
  return {
    models: aliasMap ? applyDocumentedAliases(models, aliasMap) : models,
    docsFailures: docsReport(docs),
  }
}

function toolsOnly(rawId: string) {
  const { serverTools, sources } = anthropicServerTools(rawId)
  return { serverTools, factSources: { serverTools: sources } }
}

export const anthropicProvider: ProviderConfig = {
  id: 'anthropic',
  displayName: 'Anthropic',
  authEnvVar: 'ANTHROPIC_API_KEY',
  defaultDerivation: 'upstream-spec',
  specGrain: 'provider',
  connect: headerApiKeyConnect('https://api.anthropic.com', 'x-api-key', {
    requiredHeaders: { 'anthropic-version': ANTHROPIC_VERSION },
  }),
  fetchSpec,
  listModels,
  classify,
  generationEndpointId: () => 'v1/messages',
}
