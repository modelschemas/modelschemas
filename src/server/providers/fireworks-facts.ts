/**
 * Chat facts the Fireworks inference listing does not carry.
 *
 * Standard and Fast prices are sku amounts on
 * `GET /v1/serverless/models`. Priority is a separate serving mode.
 * A row with no mode (FireRouter `auto`) names no single rate. When the
 * pricing page's Standard cell matches, that page stays the source; the
 * API fills ids the page omits. A disagreement drops that id.
 *
 * Reasoning and the shared chat request fields come from
 * `text-completion.openapi.yaml`. A family that prose does not name gets
 * the shared request map and no reasoning object.
 */
import { compileTokenCard } from '@modelschemas/rate-card'

import { tagDocsFacts } from './fact-sources.ts'
import { FIREWORKS_PRICING_URL } from './fireworks-pricing.ts'
import type {
  FireworksPricingDoc,
  FireworksRates,
} from './fireworks-pricing.ts'
import { assertParsed } from './model-facts.ts'
import type { cachedDocs } from './model-facts.ts'
import type {
  ChatRequestMap,
  EffortLevelMap,
  SharedEffortLevel,
  ThinkingRequest,
} from './request-map.ts'
import {
  fetchOpenApi,
  fetchText,
  reasoningViolation,
  sha256Text,
} from './types.ts'
import type { ModelFactSources, ModelInfo, ModelReasoning } from './types.ts'

export const FIREWORKS_SPEC_URL =
  'https://docs.fireworks.ai/text-completion.openapi.yaml'
export const FIREWORKS_SERVERLESS_URL =
  'https://api.fireworks.ai/v1/serverless/models'

const LLM_INPUT = 'LLM input tokens (uncached)'
const LLM_CACHED = 'LLM input tokens (cached)'
const LLM_OUTPUT = 'LLM output tokens'
const PER_MILLION = '1M tokens'

const EFFORT_WORDS = [
  'none',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'adaptive',
] as const

/** Backtick tokens that are request values, not model ids. */
const NOT_A_MODEL = new Set<string>([...EFFORT_WORDS, 'true', 'false'])

export interface FireworksFamily {
  tokens: Array<string>
  reasoning: ModelReasoning
  thinking: ThinkingRequest
}

export interface FireworksSharedRequest {
  maxTokensField: 'max_completion_tokens' | 'max_tokens' | null
  developerRole: boolean | null
  replayReasoningContent: boolean | null
  sessionAffinity: boolean | null
}

export interface FireworksChatSpec {
  families: Array<FireworksFamily>
  shared: FireworksSharedRequest
}

export interface FireworksServerlessDoc {
  rates: Record<string, FireworksRates>
  context: Record<string, number>
  hash: string
  extractedAt: string
}

export interface FireworksPriced {
  rates: FireworksRates
  sourceUrl: string
  sourceHash: string
  extractedAt: string
}

interface ServerlessRow {
  id: string
  mode: string | null
  usage: string
  pricing: unknown
  context: number | null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  return value as Record<string, unknown>
}

function schema(spec: unknown, name: string): Record<string, unknown> | null {
  const root = asRecord(spec)
  const components = asRecord(root?.components)
  const schemas = asRecord(components?.schemas)
  return asRecord(schemas?.[name])
}

function properties(
  node: Record<string, unknown> | null,
): Record<string, unknown> | null {
  return asRecord(node?.properties)
}

function descriptionOf(node: unknown): string {
  const record = asRecord(node)
  return typeof record?.description === 'string' ? record.description : ''
}

function fireworksSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/&/g, ' ')
    .replace(/\./g, 'p')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Markdown wraps `'none'` as a code span. The quotes are the value. */
function prose(body: string): string {
  return body.replace(/`/g, '')
}

function quotedEfforts(body: string): Array<string> {
  const found = new Set<string>()
  for (const match of prose(body).matchAll(/'([a-z]+)'/g)) {
    const word = match[1]
    if (word && (EFFORT_WORDS as ReadonlyArray<string>).includes(word)) {
      found.add(word)
    }
  }
  return EFFORT_WORDS.filter((word) => found.has(word))
}

function levelsFor(efforts: ReadonlyArray<string>): EffortLevelMap {
  const accepted = new Set(efforts)
  const value = (level: SharedEffortLevel): string | null => {
    if (level === 'off') return accepted.has('none') ? 'none' : null
    if (level === 'minimal') return accepted.has('minimal') ? 'minimal' : null
    return accepted.has(level) ? level : null
  }
  return {
    off: value('off'),
    minimal: value('minimal'),
    low: value('low'),
    medium: value('medium'),
    high: value('high'),
    xhigh: value('xhigh'),
    max: value('max'),
  }
}

function effortFamily(
  body: string,
  mandatory: boolean,
): Omit<FireworksFamily, 'tokens'> | null {
  const quoted = quotedEfforts(body)
  const efforts = mandatory ? quoted.filter((word) => word !== 'none') : quoted
  const positive = efforts.filter((word) => word !== 'none')
  const on = positive.includes('high') ? 'high' : positive[0]
  if (!on || positive.length === 0) return null
  return {
    reasoning: { mode: 'effort', mandatory, efforts },
    thinking: {
      on: { reasoning_effort: on },
      off: efforts.includes('none') ? { reasoning_effort: 'none' } : null,
      levels: levelsFor(efforts),
    },
  }
}

/**
 * The bullet's own words decide the mode. Binary on/off is a toggle.
 * A bullet that rejects `'none'` cannot be turned off. A bullet that says
 * thinking can be disabled is effort, and the quoted levels are the
 * accepted strings (a promoted level is still accepted).
 */
function classifyBullet(body: string): Omit<FireworksFamily, 'tokens'> | null {
  const text = prose(body)
  if (/binary on\/off/i.test(text)) {
    return {
      reasoning: { mode: 'toggle', mandatory: false },
      thinking: {
        on: { reasoning_effort: true },
        off: { reasoning_effort: 'none' },
        levels: null,
      },
    }
  }
  const noneRejected =
    /always on/i.test(text) ||
    /does not support\s+'none'/i.test(text) ||
    /'none'[^.]{0,120}rejected/i.test(text)
  if (noneRejected) return effortFamily(body, true)
  if (/to disable|disables thinking|disables reasoning/i.test(text)) {
    return effortFamily(body, false)
  }
  return null
}

function tokensFrom(heading: string, body: string): Array<string> {
  const pieces = heading.split(/[(),/]/).map(fireworksSlug)
  const ticks = [...body.matchAll(/`([a-z0-9]+(?:-[a-z0-9]+)*)`/g)].flatMap(
    (match) => (match[1] ? [match[1]] : []),
  )
  const tokens: Array<string> = []
  const add = (token: string) => {
    if (!token || NOT_A_MODEL.has(token) || tokens.includes(token)) return
    tokens.push(token)
  }
  for (const token of pieces) add(token)
  // Rejected effort names (`minimal`, `ultra`) are backticked too. The
  // conversation styles this spec names all include a digit.
  for (const token of ticks) {
    if (token.includes('no-thinking') || !/\d/.test(token)) continue
    add(token)
  }
  return tokens
}

function familiesFrom(description: string): Array<FireworksFamily> {
  const marker = description.indexOf('Model-specific behavior:')
  if (marker < 0) return []
  const section = description.slice(marker)
  const families: Array<FireworksFamily> = []
  const bullets = section.matchAll(
    /\n-\s+\*\*([^*]+)\*\*:\s*([\s\S]*?)(?=\n-\s+\*\*|$)/g,
  )
  for (const match of bullets) {
    const heading = match[1]?.trim()
    const body = match[2]?.trim()
    if (!heading || !body) continue
    const classified = classifyBullet(body)
    if (!classified || reasoningViolation(classified.reasoning)) continue
    const tokens = tokensFrom(heading, body)
    if (tokens.length === 0) continue
    families.push({ tokens, ...classified })
  }
  return families
}

/** MiniMax M3 is not a model-specific bullet. Its schema says adaptive. */
function adaptiveFamily(
  spec: unknown,
  description: string,
  families: ReadonlyArray<FireworksFamily>,
): FireworksFamily | null {
  const about = descriptionOf(schema(spec, 'ThinkingConfigAdaptive'))
  const named = /MiniMax M3/.exec(about)
  if (!named || !/adaptive/i.test(about)) return null
  if (!/'adaptive' is supported only by MiniMax M3/.test(prose(description))) {
    return null
  }
  const token = fireworksSlug(named[0])
  if (families.some((family) => family.tokens.includes(token))) return null
  return {
    tokens: [token],
    reasoning: { mode: 'adaptive', mandatory: null, efforts: ['adaptive'] },
    thinking: {
      on: { thinking: { type: 'adaptive' } },
      off: null,
      levels: null,
    },
  }
}

function sharedRequest(
  spec: unknown,
  props: Record<string, unknown>,
): FireworksSharedRequest {
  const hasMax = 'max_tokens' in props
  const hasCompletion = 'max_completion_tokens' in props
  const alias = /alias for max_tokens/i.test(
    descriptionOf(props.max_completion_tokens),
  )
  let maxTokensField: FireworksSharedRequest['maxTokensField'] = null
  if (hasMax && alias) maxTokensField = 'max_tokens'
  else if (hasMax && !hasCompletion) maxTokensField = 'max_tokens'
  else if (hasCompletion && !hasMax) maxTokensField = 'max_completion_tokens'

  const message = properties(schema(spec, 'ChatMessage'))
  const roles = [
    ...descriptionOf(message?.role).matchAll(/`([a-z]+)`/g),
  ].flatMap((match) => (match[1] ? [match[1]] : []))
  return {
    maxTokensField,
    developerRole: roles.length === 0 ? null : roles.includes('developer'),
    replayReasoningContent:
      message !== null && 'reasoning_content' in message ? true : null,
    sessionAffinity: /session affinity/i.test(
      descriptionOf(props.prompt_cache_key),
    )
      ? true
      : null,
  }
}

export function parseFireworksChatSpec(spec: unknown): FireworksChatSpec {
  const request = schema(spec, 'ChatCompletionRequest')
  const props = properties(request)
  if (!request || !props) {
    throw new Error('fireworks chat spec: ChatCompletionRequest is missing')
  }
  const description = descriptionOf(props.reasoning_effort)
  const families = familiesFrom(description)
  const adaptive = adaptiveFamily(spec, description, families)
  if (adaptive) families.push(adaptive)
  if (families.length === 0) {
    throw new Error('fireworks chat spec: parsed 0 reasoning families')
  }
  return { families, shared: sharedRequest(spec, props) }
}

function tokenMatches(slug: string, token: string): boolean {
  return (
    slug === token || slug.startsWith(`${token}-`) || token.endsWith(`-${slug}`)
  )
}

/** Longest style or heading token wins. The id used is the last path segment. */
export function matchFireworksFamily(
  rawId: string,
  families: ReadonlyArray<FireworksFamily>,
): FireworksFamily | null {
  const slash = rawId.lastIndexOf('/')
  const slug = (slash === -1 ? rawId : rawId.slice(slash + 1)).toLowerCase()
  let best: { family: FireworksFamily; length: number } | null = null
  for (const family of families) {
    for (const token of family.tokens) {
      if (!tokenMatches(slug, token)) continue
      if (best && token.length <= best.length) continue
      best = { family, length: token.length }
    }
  }
  return best?.family ?? null
}

export function fireworksRequestMap(
  shared: FireworksSharedRequest,
  family: FireworksFamily | null,
): ChatRequestMap {
  return {
    thinking: family?.thinking ?? null,
    maxTokensField: shared.maxTokensField,
    developerRole: shared.developerRole,
    replayReasoningContent: shared.replayReasoningContent,
    store: null,
    strictTools: null,
    sessionAffinity: shared.sessionAffinity,
    cacheControl: null,
    toolStream: null,
    reasoningEffort: family ? true : null,
  }
}

function serverlessRows(body: unknown): Array<ServerlessRow> {
  const root = asRecord(body)
  const data = Array.isArray(body) ? body : root?.data
  if (!Array.isArray(data)) {
    throw new Error('fireworks serverless models: unreadable response')
  }
  const rows: Array<ServerlessRow> = []
  for (const item of data) {
    const record = asRecord(item)
    if (!record || typeof record.id !== 'string' || record.id.length === 0) {
      continue
    }
    const mode = record.serverless_mode
    const context = record.context_length
    rows.push({
      id: record.id,
      mode: typeof mode === 'string' ? mode : null,
      usage:
        typeof record.usage_identifier === 'string'
          ? record.usage_identifier
          : '',
      pricing: record.pricing,
      context:
        typeof context === 'number' && Number.isInteger(context) && context > 0
          ? context
          : null,
    })
  }
  return rows
}

/** Fast prices `usage_identifier`. Standard prices that id, or else `id`. */
function billedId(row: ServerlessRow): string | null {
  if (row.mode === 'fast') return row.usage.length > 0 ? row.usage : null
  if (row.mode === 'standard') return row.usage.length > 0 ? row.usage : row.id
  return null
}

function money(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  if (typeof value === 'string' && value.trim() === '') return null
  const amount = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(amount) || amount < 0) return null
  return amount
}

function skuAmount(pricing: Array<unknown>, sku: string): number | null {
  const hits = pricing.filter((item) => asRecord(item)?.sku === sku)
  if (hits.length !== 1) return null
  const row = asRecord(hits[0])
  if (!row || row.unit !== PER_MILLION) return null
  return money(row.amount)
}

function llmRates(pricing: unknown): FireworksRates | null {
  if (!Array.isArray(pricing)) return null
  const input = skuAmount(pricing, LLM_INPUT)
  const cacheRead = skuAmount(pricing, LLM_CACHED)
  const output = skuAmount(pricing, LLM_OUTPUT)
  if (input === null || cacheRead === null || output === null) return null
  return { input, cacheRead, output }
}

function sameRates(left: FireworksRates, right: FireworksRates): boolean {
  return (
    left.input === right.input &&
    left.cacheRead === right.cacheRead &&
    left.output === right.output
  )
}

/**
 * Priority and modeless rows are skipped. Embedding-only skus are not a
 * chat card. Two billed ids with different amounts are dropped.
 */
export function parseFireworksServerless(body: unknown): {
  rates: Map<string, FireworksRates>
  context: Map<string, number>
} {
  const rates = new Map<string, FireworksRates>()
  const dropped = new Set<string>()
  const context = new Map<string, number>()
  const contextDropped = new Set<string>()
  for (const row of serverlessRows(body)) {
    const id = billedId(row)
    if (!id) continue
    const price = llmRates(row.pricing)
    if (price) {
      const prior = rates.get(id)
      if (dropped.has(id) || (prior && !sameRates(prior, price))) {
        rates.delete(id)
        dropped.add(id)
      } else if (!prior) {
        rates.set(id, price)
      }
    }
    if (row.context !== null) {
      const prior = context.get(id)
      if (
        contextDropped.has(id) ||
        (prior !== undefined && prior !== row.context)
      ) {
        context.delete(id)
        contextDropped.add(id)
      } else if (prior === undefined) {
        context.set(id, row.context)
      }
    }
  }
  return { rates, context }
}

export function loadFireworksServerless(
  kv: KVNamespace | undefined,
  cached: typeof cachedDocs,
  apiKey: string,
): Promise<FireworksServerlessDoc> {
  return cached(kv, FIREWORKS_SERVERLESS_URL, async () => {
    const text = await fetchText(FIREWORKS_SERVERLESS_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    const parsed: unknown = JSON.parse(text)
    const rows = parseFireworksServerless(parsed)
    assertParsed(rows.rates, 'fireworks serverless models')
    return {
      rates: Object.fromEntries(rows.rates),
      context: Object.fromEntries(rows.context),
      hash: await sha256Text(text),
      extractedAt: new Date().toISOString(),
    }
  })
}

export function loadFireworksChatSpec(
  kv: KVNamespace | undefined,
  cached: typeof cachedDocs,
): Promise<FireworksChatSpec & { hash: string }> {
  return cached(kv, FIREWORKS_SPEC_URL, async () => {
    const { spec, hash } = await fetchOpenApi(FIREWORKS_SPEC_URL)
    return { ...parseFireworksChatSpec(spec), hash }
  })
}

export function mergeFireworksRates(
  markdown: FireworksPricingDoc | null,
  serverless: FireworksServerlessDoc | null,
): Record<string, FireworksPriced> | null {
  if (!markdown && !serverless) return null
  const prices: Record<string, FireworksPriced> = {}
  const ids = new Set([
    ...Object.keys(markdown?.rates ?? {}),
    ...Object.keys(serverless?.rates ?? {}),
  ])
  for (const id of ids) {
    const page = markdown?.rates[id]
    const api = serverless?.rates[id]
    if (page && api && !sameRates(page, api)) continue
    if (page) {
      prices[id] = {
        rates: page,
        sourceUrl: FIREWORKS_PRICING_URL,
        sourceHash: markdown.hash,
        extractedAt: markdown.extractedAt,
      }
      continue
    }
    if (api) {
      prices[id] = {
        rates: api,
        sourceUrl: FIREWORKS_SERVERLESS_URL,
        sourceHash: serverless.hash,
        extractedAt: serverless.extractedAt,
      }
    }
  }
  return prices
}

function capabilityList(value: unknown): Array<string> {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

const REASONING_PATH =
  'components/schemas/ChatCompletionRequest/properties/reasoning_effort/description'

export function applyFireworksDocs(
  model: ModelInfo,
  input: {
    prices: Record<string, FireworksPriced> | null
    context: Record<string, number>
    contextHash: string | null
    chat: (FireworksChatSpec & { hash: string }) | null
  },
): Partial<ModelInfo> {
  const patch: Partial<ModelInfo> = {}
  const sources: ModelFactSources = {}
  const absent: NonNullable<ModelInfo['absent']> = {}
  if (input.prices === null) {
    absent.pricing = 'unavailable'
  } else {
    const row = input.prices[model.rawId]
    if (row) {
      const pricing = compileTokenCard(
        {
          input_tokens: row.rates.input / 1e6,
          output_tokens: row.rates.output / 1e6,
          cache_read_tokens: row.rates.cacheRead / 1e6,
        },
        [],
        {
          url: row.sourceUrl,
          hash: row.sourceHash,
          extractedAt: row.extractedAt,
        },
      )
      if (pricing) {
        patch.pricing = pricing
        Object.assign(
          sources,
          tagDocsFacts({ pricing }, row.sourceUrl, row.sourceHash),
        )
      }
    }
  }
  const context = input.context[model.rawId]
  if (model.contextWindow == null && context !== undefined) {
    patch.contextWindow = context
    sources.contextWindow = {
      derivation: 'listing',
      sourceUrl: FIREWORKS_SERVERLESS_URL,
      ...(input.contextHash ? { sourceHash: input.contextHash } : {}),
      path: 'context_length',
    }
  }
  if (model.activity === 'chat') {
    if (!input.chat) {
      absent.reasoning = 'unavailable'
      absent.requestMap = 'unavailable'
    } else {
      const family = matchFireworksFamily(model.rawId, input.chat.families)
      patch.requestMap = fireworksRequestMap(input.chat.shared, family)
      if (family) {
        patch.reasoning = family.reasoning
        if (Array.isArray(model.capabilities) || model.capabilities == null) {
          const caps = capabilityList(model.capabilities)
          if (!caps.includes('reasoning')) caps.push('reasoning')
          patch.capabilities = caps
        }
        const source = {
          derivation: 'docs-derived' as const,
          sourceUrl: FIREWORKS_SPEC_URL,
          sourceHash: input.chat.hash,
          path: REASONING_PATH,
        }
        sources.reasoning = source
        sources.capabilities = { reasoning: source }
      }
    }
  }
  if (
    sources.pricing ||
    sources.contextWindow ||
    sources.reasoning ||
    sources.capabilities
  ) {
    patch.factSources = sources
  }
  if (Object.keys(absent).length > 0) {
    patch.absent = { ...model.absent, ...absent }
  }
  return patch
}
