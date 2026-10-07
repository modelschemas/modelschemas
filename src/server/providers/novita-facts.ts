/**
 * Novita chat facts the keyed `/models` row does not state.
 *
 * Request wire and sampling flags: the chat-completion markdown.
 * `enable_thinking` ids the chat spec omits: the LLM FAQ.
 * Per-model reasoning close, tool_choice, and JSON modes: the public
 * product catalog the docs site loads (`features_v2`).
 */
import { tryDocs } from './model-facts.ts'
import type { DocsRun } from './model-facts.ts'
import { overlayModelFacts } from './reasoning-config.ts'
import type { ChatRequestMap, ThinkingRequest } from './request-map.ts'
import { fetchText, sha256Text } from './types.ts'
import type {
  FactSource,
  ModelFactSources,
  ModelInfo,
  ModelReasoning,
} from './types.ts'

export const NOVITA_CHAT_DOC_URL =
  'https://docs.novita.ai/api-reference/model-apis-llm-create-chat-completion.md'
export const NOVITA_FAQ_URL = 'https://docs.novita.ai/guides/LLM-FAQ.md'
export const NOVITA_PRODUCT_MODELS_URL =
  'https://api-server.novita.ai/v1/product/model/list'

/** Top-level chat fields with no per-model restriction in the spec. */
const CHAT_FLAGS = [
  'max_tokens',
  'temperature',
  'top_p',
  'top_k',
  'stop',
  'seed',
  'frequency_penalty',
  'presence_penalty',
] as const

const FLAG_ORDER = [
  'tools',
  'tool_choice',
  'reasoning',
  'structured_outputs',
  'response_format',
  ...CHAT_FLAGS,
]

export interface NovitaChatDoc {
  hash: string
  developerRole: boolean
  flags: Array<string>
  /**
   * Ids the spec names under `enable_thinking`. Null when the field is
   * published with no supported-model list (every chat model).
   */
  enableThinkingIds: Array<string> | null
}

export interface NovitaFaqIds {
  hash: string
  ids: Array<string>
}

export interface NovitaProductModel {
  reasoning: { enabled: boolean; close: boolean | null } | null
  tools: boolean | null
  toolChoice: boolean | null
  structured: {
    enabled: boolean
    jsonSchema: boolean | null
    jsonObject: boolean | null
  } | null
}

export interface NovitaProductCatalog {
  hash: string
  byId: Record<string, NovitaProductModel>
}

export interface NovitaDocs {
  modelsUrl: string
  chat: NovitaChatDoc | null
  faqIds: Array<string> | null
  product: NovitaProductCatalog | null
}

interface ParamField {
  name: string
  indent: number
  body: string
}

export function parseNovitaChatDoc(text: string, hash: string): NovitaChatDoc {
  const fields = paramFields(text)
  const top = new Set(
    fields.filter((field) => field.indent === 0).map((field) => field.name),
  )
  if (!top.has('max_tokens')) {
    throw new Error('novita chat doc: max_tokens is missing')
  }
  const role = fields.find((field) => field.name === 'role')
  if (!role) throw new Error('novita chat doc: role is missing')
  const roles = roleEnum(role.body)
  const thinking = fields.find((field) => field.name === 'enable_thinking')
  return {
    hash,
    developerRole: roles.includes('developer'),
    flags: CHAT_FLAGS.filter((flag) => top.has(flag)),
    enableThinkingIds: thinkingIds(thinking),
  }
}

export function parseNovitaFaqIds(text: string, hash: string): NovitaFaqIds {
  const ids = new Set<string>()
  for (const fence of text.matchAll(/```[\s\S]*?```/g)) {
    const body = fence[0]
    if (!/"enable_thinking"\s*:\s*false/.test(body)) continue
    const model = /"model"\s*:\s*"([^"]+)"/.exec(body)
    if (model?.[1]?.includes('/')) ids.add(model[1])
  }
  for (const line of text.split('\n')) {
    if (!line.includes('enable_thinking')) continue
    for (const match of line.matchAll(/\*\*([^*]+)\*\*/g)) {
      const id = match[1]?.trim() ?? ''
      if (id.includes('/')) ids.add(id)
    }
  }
  if (ids.size === 0) {
    throw new Error('novita faq: parsed 0 enable_thinking ids')
  }
  return { hash, ids: [...ids] }
}

export function parseNovitaProductModels(
  body: unknown,
  hash: string,
): NovitaProductCatalog {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('novita product models: data is empty')
  }
  const data = (body as { data?: unknown }).data
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error('novita product models: data is empty')
  }
  const byId: Record<string, NovitaProductModel> = {}
  const seen = new Set<string>()
  for (const row of data) {
    if (!isRecord(row)) throw new Error('novita product models: row lacks id')
    const id = row.id
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('novita product models: row lacks id')
    }
    if (seen.has(id)) throw new Error(`novita product models: duplicate ${id}`)
    seen.add(id)
    if (row.features_v2 == null) continue
    byId[id] = productModel(row.features_v2, id)
  }
  if (Object.keys(byId).length === 0) {
    throw new Error('novita product models: parsed 0 model rows')
  }
  return { hash, byId }
}

/** Merge one poll's docs onto a keyed row. A failed source keeps the stored fact. */
export function applyNovitaDocs(model: ModelInfo, docs: NovitaDocs): ModelInfo {
  if (model.activity !== 'chat') return model
  const flags = new Set(stringList(model.capabilities))
  const sources = new Map<string, FactSource>()
  const listing = (path: string): FactSource => ({
    derivation: 'listing',
    sourceUrl: docs.modelsUrl,
    path,
  })
  for (const flag of flags) sources.set(flag, listing('features'))

  const product = docs.product?.byId[model.rawId]
  if (product && docs.product) {
    applyProductFeatures(flags, sources, product, docs.product.hash)
  }

  const factSources: ModelFactSources = {}
  const patch: Partial<ModelInfo> = {}
  if (docs.chat) {
    const chat = docs.chat
    const chatSource = (path: string): FactSource => ({
      derivation: 'docs-derived',
      sourceUrl: NOVITA_CHAT_DOC_URL,
      sourceHash: chat.hash,
      path,
    })
    for (const flag of chat.flags) {
      flags.add(flag)
      sources.set(flag, chatSource(flag))
    }
    patch.exactCapabilities = true
    patch.requestMap = requestMap(model.rawId, docs, product)
    factSources.requestMap = chatSource('max_tokens')
  }

  const ordered = FLAG_ORDER.filter((flag) => flags.has(flag))
  patch.capabilities = ordered.length > 0 ? ordered : null
  if (ordered.length > 0) {
    factSources.capabilities = Object.fromEntries(
      ordered.map((flag) => [flag, sources.get(flag) ?? listing(flag)]),
    )
  }

  const close = product?.reasoning?.enabled ? product.reasoning.close : null
  if (docs.product && typeof close === 'boolean') {
    patch.reasoning = {
      mode: 'toggle',
      mandatory: !close,
    } satisfies ModelReasoning
    factSources.reasoning = {
      derivation: 'listing',
      sourceUrl: NOVITA_PRODUCT_MODELS_URL,
      sourceHash: docs.product.hash,
      path: 'features_v2.reasoning.subFeatures.close',
    }
  }

  const absent: NonNullable<ModelInfo['absent']> = {}
  if (!docs.chat) absent.requestMap = 'unavailable'
  if (!docs.product) absent.reasoning = 'unavailable'
  if (Object.keys(absent).length > 0)
    patch.absent = { ...model.absent, ...absent }
  if (Object.keys(factSources).length > 0) patch.factSources = factSources
  return overlayModelFacts(model, patch)
}

export async function loadNovitaDocs(
  run: DocsRun,
  kv: KVNamespace | undefined,
  modelsUrl: string,
  models: Array<ModelInfo>,
): Promise<Array<ModelInfo>> {
  const [chat, faq, product] = await Promise.all([
    tryDocs(run, NOVITA_CHAT_DOC_URL, (cached) =>
      cached(kv, NOVITA_CHAT_DOC_URL, async () => {
        const text = await fetchText(NOVITA_CHAT_DOC_URL)
        return parseNovitaChatDoc(text, await sha256Text(text))
      }),
    ),
    tryDocs(run, NOVITA_FAQ_URL, (cached) =>
      cached(kv, NOVITA_FAQ_URL, async () => {
        const text = await fetchText(NOVITA_FAQ_URL)
        return parseNovitaFaqIds(text, await sha256Text(text))
      }),
    ),
    tryDocs(run, NOVITA_PRODUCT_MODELS_URL, (cached) =>
      cached(kv, NOVITA_PRODUCT_MODELS_URL, async () => {
        const text = await fetchText(NOVITA_PRODUCT_MODELS_URL)
        const parsed: unknown = JSON.parse(text)
        return parseNovitaProductModels(parsed, await sha256Text(text))
      }),
    ),
  ])
  const docs: NovitaDocs = {
    modelsUrl,
    chat,
    faqIds: faq?.ids ?? null,
    product,
  }
  return models.map((model) => applyNovitaDocs(model, docs))
}

function requestMap(
  rawId: string,
  docs: NovitaDocs,
  product: NovitaProductModel | undefined,
): ChatRequestMap {
  return {
    thinking: thinkingBody(rawId, docs, product),
    maxTokensField: 'max_tokens',
    developerRole: docs.chat?.developerRole ?? null,
    replayReasoningContent: null,
    store: null,
    strictTools: null,
    sessionAffinity: null,
    cacheControl: null,
    toolStream: null,
    reasoningEffort: null,
  }
}

function thinkingBody(
  rawId: string,
  docs: NovitaDocs,
  product: NovitaProductModel | undefined,
): ThinkingRequest | null {
  const listed = docs.chat?.enableThinkingIds
  const named =
    listed === null ||
    listed?.includes(rawId) === true ||
    docs.faqIds?.includes(rawId) === true
  if (!named) return null
  const close = product?.reasoning?.close
  return {
    on: { enable_thinking: true },
    off: close === false ? null : { enable_thinking: false },
    levels: null,
  }
}

function applyProductFeatures(
  flags: Set<string>,
  sources: Map<string, FactSource>,
  row: NovitaProductModel,
  hash: string,
): void {
  const source = (path: string): FactSource => ({
    derivation: 'listing',
    sourceUrl: NOVITA_PRODUCT_MODELS_URL,
    sourceHash: hash,
    path,
  })
  if (row.tools !== null) {
    if (row.tools) {
      flags.add('tools')
      sources.set('tools', source('features_v2.function-calling'))
    } else {
      flags.delete('tools')
      sources.delete('tools')
      flags.delete('tool_choice')
      sources.delete('tool_choice')
    }
  }
  if (row.tools === true && row.toolChoice === true) {
    flags.add('tool_choice')
    sources.set(
      'tool_choice',
      source('features_v2.function-calling.subFeatures.tool_choice'),
    )
  } else if (row.tools !== null) {
    flags.delete('tool_choice')
    sources.delete('tool_choice')
  }
  const structured = row.structured
  if (structured) {
    if (!structured.enabled) {
      flags.delete('structured_outputs')
      flags.delete('response_format')
      sources.delete('structured_outputs')
      sources.delete('response_format')
    } else if (structured.jsonSchema == null && structured.jsonObject == null) {
      flags.add('structured_outputs')
      flags.add('response_format')
      const both = source('features_v2.structured-outputs')
      sources.set('structured_outputs', both)
      sources.set('response_format', both)
    } else {
      if (structured.jsonSchema === true) {
        flags.add('structured_outputs')
        sources.set(
          'structured_outputs',
          source('features_v2.structured-outputs.subFeatures.json_schema'),
        )
      } else {
        flags.delete('structured_outputs')
        sources.delete('structured_outputs')
      }
      if (structured.jsonObject === true) {
        flags.add('response_format')
        sources.set(
          'response_format',
          source('features_v2.structured-outputs.subFeatures.json_object'),
        )
      } else {
        flags.delete('response_format')
        sources.delete('response_format')
      }
    }
  }
  if (row.reasoning) {
    if (row.reasoning.enabled) {
      flags.add('reasoning')
      sources.set('reasoning', source('features_v2.reasoning'))
    } else {
      flags.delete('reasoning')
      sources.delete('reasoning')
    }
  }
}

function productModel(features: unknown, id: string): NovitaProductModel {
  if (!Array.isArray(features)) {
    throw new Error(`novita product models: ${id} features_v2 is not an array`)
  }
  const byName = new Map<string, FeatureRow>()
  for (const raw of features) {
    const feature = featureRow(raw, id)
    if (byName.has(feature.name)) {
      throw new Error(`novita product models: ${id} duplicate ${feature.name}`)
    }
    byName.set(feature.name, feature)
  }
  const calling = byName.get('function-calling')
  const structured = byName.get('structured-outputs')
  const reasoning = byName.get('reasoning')
  return {
    tools: calling ? calling.enabled : null,
    toolChoice: calling
      ? optionalBool(calling.subFeatures.tool_choice, id, 'tool_choice')
      : null,
    structured: structured
      ? {
          enabled: structured.enabled,
          jsonSchema: optionalBool(
            structured.subFeatures.json_schema,
            id,
            'json_schema',
          ),
          jsonObject: optionalBool(
            structured.subFeatures.json_object,
            id,
            'json_object',
          ),
        }
      : null,
    reasoning: reasoning
      ? {
          enabled: reasoning.enabled,
          close: optionalBool(reasoning.subFeatures.close, id, 'close'),
        }
      : null,
  }
}

interface FeatureRow {
  name: string
  enabled: boolean
  subFeatures: Record<string, unknown>
}

function featureRow(value: unknown, id: string): FeatureRow {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`novita product models: ${id} feature is not an object`)
  }
  const row = value as {
    name?: unknown
    enabled?: unknown
    subFeatures?: unknown
  }
  if (typeof row.name !== 'string' || row.name.length === 0) {
    throw new Error(`novita product models: ${id} feature lacks a name`)
  }
  if (typeof row.enabled !== 'boolean') {
    throw new Error(
      `novita product models: ${id} ${row.name} enabled is not a boolean`,
    )
  }
  let subFeatures: Record<string, unknown> = {}
  if (row.subFeatures != null) {
    if (!isRecord(row.subFeatures)) {
      throw new Error(
        `novita product models: ${id} ${row.name} subFeatures is not an object`,
      )
    }
    subFeatures = row.subFeatures
  }
  return { name: row.name, enabled: row.enabled, subFeatures }
}

function optionalBool(
  value: unknown,
  id: string,
  path: string,
): boolean | null {
  if (value == null) return null
  if (typeof value !== 'boolean') {
    throw new Error(`novita product models: ${id} ${path} is not a boolean`)
  }
  return value
}

function thinkingIds(field: ParamField | undefined): Array<string> | null {
  if (!field) return []
  if (!/Supported models\s*:/.test(field.body)) return null
  const lines = field.body.split('\n')
  const start = lines.findIndex((line) => /Supported models\s*:/.test(line))
  const ids: Array<string> = []
  for (const line of lines.slice(start + 1)) {
    const match = /^\s*\*\s+`?([^`\s]+)`?\s*$/.exec(line)
    if (match?.[1]?.includes('/')) ids.push(match[1])
  }
  if (ids.length === 0) {
    throw new Error('novita chat doc: enable_thinking lists no models')
  }
  return ids
}

function roleEnum(body: string): Array<string> {
  const line = body.split('\n').find((item) => item.includes('Enum:'))
  if (!line) throw new Error('novita chat doc: role enum is missing')
  const tokens = [...line.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? '')
  if (tokens.length === 0 || tokens.some((token) => token.length === 0)) {
    throw new Error('novita chat doc: role enum is missing')
  }
  return tokens
}

function paramFields(text: string): Array<ParamField> {
  const lines = text.split('\n')
  const fields: Array<ParamField> = []
  for (let i = 0; i < lines.length; i++) {
    const open = /^( *)<ParamField body="([^"]+)"/.exec(lines[i] ?? '')
    if (!open) continue
    const indent = open[1]?.length ?? 0
    const name = open[2] ?? ''
    let end = lines.length - 1
    for (let j = i + 1; j < lines.length; j++) {
      const close = /^( *)<\/ParamField>/.exec(lines[j] ?? '')
      if (close && (close[1]?.length ?? 0) === indent) {
        end = j
        break
      }
    }
    fields.push({ name, indent, body: lines.slice(i, end + 1).join('\n') })
  }
  return fields
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringList(value: unknown): Array<string> {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}
