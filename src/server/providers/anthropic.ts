/**
 * Anthropic — official OpenAPI spec published by Anthropic's
 * Stainless-generated SDKs. The `.stats.yml` in anthropic-sdk-typescript
 * declares the current `openapi_spec_url` (a hash-stamped YAML in GCS that
 * updates whenever Anthropic ships a new API revision) — that URL doubles
 * as our specRevision.
 */
import { parse } from 'yaml'

import type { Activity } from '#/db/schema.ts'
import {
  assertParsed,
  dollars,
  markdownTableRows,
  memoized,
  pricingPerMillion,
} from './model-facts.ts'
import { isoToEpochSeconds } from './release-dates.ts'
import {
  fetchJson,
  fetchText,
  resolveStainlessSpecUrl,
  sha256Text,
  skippedResult,
} from './types.ts'
import { headerApiKeyConnect } from './connect.ts'
import type {
  ListModelsResult,
  OpenApiDocument,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from './types.ts'

const ANTHROPIC_STATS_URL =
  'https://raw.githubusercontent.com/anthropics/anthropic-sdk-typescript/main/.stats.yml'
const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models'
const ANTHROPIC_VERSION = '2023-06-01'
/**
 * Pricing table, served as markdown by Anthropic's docs. Columns: model |
 * base input | 5m cache write | 1h cache write | cache hit | output, all
 * USD/MTok. Rows are display names (matching the Models API
 * `display_name`), sometimes with a trailing parenthetical.
 */
export const ANTHROPIC_PRICING_URL =
  'https://platform.claude.com/docs/en/about-claude/pricing.md'

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
  const specUrl = await resolveStainlessSpecUrl(
    'anthropic',
    ANTHROPIC_STATS_URL,
  )
  const yamlText = await fetchText(specUrl)
  const spec = parse(yamlText) as OpenApiDocument
  return {
    specs: [spec],
    sources: [{ url: specUrl, hash: await sha256Text(yamlText) }],
    outputStrategy: 'post-200',
    specRevision: specUrl,
  }
}

/**
 * Docs-derived rules the Models API capability tree does not carry:
 * thinking cannot be turned off on the Fable/Mythos tier (`{type:
 * "disabled"}` is a 400 — the tree reads the same as adaptive-by-default
 * Opus 5), and sampling params (temperature/top_p/top_k) are rejected from
 * Opus 4.7 onward (Fable, Opus 4.7/4.8/5, Sonnet 5).
 */
const ALWAYS_THINKING = /^claude-(fable|mythos)-/
const SAMPLING_REMOVED =
  /^claude-(fable|mythos|opus-5|opus-4-[78]|sonnet-5)(-|$)/

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
    thinking?: Supported
    effort?: Supported
  }
}

interface AnthropicModelList {
  data?: Array<AnthropicModel>
  has_more?: boolean
  last_id?: string
}

/**
 * Parse the pricing table: display name → USD/MTok figures. Parentheticals
 * (`Claude Opus 4.1 ([retired…](…))`) are stripped before matching.
 */
export function parseAnthropicPricing(
  markdown: string,
): Map<string, Record<string, string> | null> {
  const out = new Map<string, Record<string, string> | null>()
  for (const [
    label = '',
    input,
    write5m,
    ,
    cacheHit,
    output,
  ] of markdownTableRows(markdown)) {
    if (!label.startsWith('Claude ') || output === undefined) continue
    const name = label.replace(/\s*\(.*$/, '').trim()
    if (out.has(name)) continue // batch table repeats the names further down
    out.set(
      name,
      pricingPerMillion({
        prompt: dollars(input),
        input_cache_write: dollars(write5m),
        input_cache_read: dollars(cacheHit),
        completion: dollars(output),
      }),
    )
  }
  return out
}

/** Request features from the Models API capability tree + the docs rules. */
export function anthropicCapabilities(m: AnthropicModel): Array<string> {
  const caps = m.capabilities
  const out = ['tools', 'tool_choice']
  if (caps?.thinking?.supported) out.push('reasoning')
  if (caps?.effort?.supported) out.push('reasoning_effort')
  if (caps?.thinking?.supported && ALWAYS_THINKING.test(m.id)) {
    out.push('reasoning_mandatory')
  }
  if (!SAMPLING_REMOVED.test(m.id)) out.push('temperature', 'top_p', 'top_k')
  if (caps?.structured_outputs?.supported) {
    out.push('structured_outputs', 'response_format')
  }
  return out
}

async function listModels(env: ProviderSecrets): Promise<ListModelsResult> {
  const key = env.ANTHROPIC_API_KEY
  if (!key) {
    return { models: [], ...skippedResult('anthropic', 'ANTHROPIC_API_KEY') }
  }
  const headers = { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION }
  const pricing = await memoized(ANTHROPIC_PRICING_URL, async () => {
    const parsed = parseAnthropicPricing(await fetchText(ANTHROPIC_PRICING_URL))
    assertParsed(parsed, 'anthropic pricing docs')
    return parsed
  })
  const models: ListModelsResult['models'] = []
  let afterId: string | undefined
  do {
    const url = new URL(ANTHROPIC_MODELS_URL)
    url.searchParams.set('limit', '100')
    if (afterId) url.searchParams.set('after_id', afterId)
    const body = (await fetchJson(url.toString(), {
      headers,
    })) as AnthropicModelList
    for (const m of body.data ?? []) {
      const input = ['text']
      if (m.capabilities?.image_input?.supported) input.push('image')
      if (m.capabilities?.pdf_input?.supported) input.push('file')
      models.push({
        rawId: m.id,
        displayName: m.display_name ?? null,
        activity: 'chat',
        releasedAt: isoToEpochSeconds(m.created_at),
        // Models API (since 2026-03) carries limits + a capability tree.
        contextWindow: m.max_input_tokens ?? null,
        maxOutput: m.max_tokens ?? null,
        modalities: m.capabilities ? { input, output: ['text'] } : null,
        pricing: (m.display_name && pricing.get(m.display_name)) ?? null,
        capabilities: m.capabilities ? anthropicCapabilities(m) : null,
      })
    }
    afterId = body.has_more ? body.last_id : undefined
  } while (afterId)
  return { models }
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
