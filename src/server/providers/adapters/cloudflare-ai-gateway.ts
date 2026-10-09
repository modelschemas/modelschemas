import { bearerConnect } from '../connect.ts'
import {
  catalogGatewayEndpoint,
  GATEWAY_REST_DOCS,
  parseGatewayRunContract,
} from '../cloudflare-gateway-schema.ts'
/**
 * Cloudflare AI Gateway — third-party models from Cloudflare's catalog.
 *
 * The pages at developers.cloudflare.com/ai/models/ are rendered from
 * `src/content/catalog-models/*.json` on cloudflare/cloudflare-docs
 * (production). Those files state context length, max output, pricing,
 * metadata, and the request schema. The rendered Model Info table drops
 * max output and the metadata rows.
 *
 * A per-1M-token price is stored only when that model's file names input
 * and output as `tokens (per 1M)`, plus cached input or cache creation
 * when those keys are present. Any other pricing key nulls the card.
 * fetchSpec binds native catalog inputs to the documented universal REST envelope.
 * Logical endpoint ids are model ids; their HTTP path remains the native /ai/run path.
 */
import { compileTokenCard } from '@modelschemas/rate-card'
import type { RateCard } from '@modelschemas/rate-card'

import type { Activity } from '#/db/schema.ts'

import { githubRequestInit } from '../github.ts'
import { cachedDocs, mapConcurrent } from '../model-facts.ts'
import type {
  ChatRequestMap,
  EffortLevelMap,
  ThinkingRequest,
} from '../request-map.ts'
import { fetchText, sha256Text } from '../types.ts'
import type {
  FactSource,
  ListModelsResult,
  ModelInfo,
  ModelReasoning,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

export const CATALOG_URL = 'https://developers.cloudflare.com/ai/models/'

/** Directory listing of the catalog files the model pages are built from. */
export const CATALOG_DIR_URL =
  'https://api.github.com/repos/cloudflare/cloudflare-docs/contents/src/content/catalog-models?ref=production'

const RAW_PREFIX =
  'https://raw.githubusercontent.com/cloudflare/cloudflare-docs/'
const RAW_DIR = '/src/content/catalog-models/'

const GITHUB_HEADERS = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'modelschemas',
}

const TASK_ACTIVITY: Record<string, Activity> = {
  'Text Generation': 'chat',
  'Text-to-Image': 'image',
  'Image-to-Image': 'image',
  'Text-to-Video': 'video',
  'Image-to-Video': 'video',
  'video-to-video': 'video',
  'Text-to-Speech': 'audio',
  'Automatic Speech Recognition': 'audio',
  'Music Generation': 'audio',
}

/** JSON keys that render as a flat per-1M-token rate. Any other key nulls the card. */
const FLAT_LEVERS: Record<string, string> = {
  'Input tokens (per 1M)': 'input_tokens',
  'Output tokens (per 1M)': 'output_tokens',
  'Cached input tokens (per 1M)': 'cache_read_tokens',
  'Cache creation tokens (per 1M)': 'cache_write_tokens',
}

const MODALITY_KEYS = [
  'Input Modalities',
  'Input modalities',
  'Modalities',
] as const

/** Catalog words for an input kind. `script` is a text script. */
const MODALITY_WORDS: Record<string, string> = {
  text: 'text',
  image: 'image',
  vision: 'image',
  audio: 'audio',
  video: 'video',
  script: 'text',
}

const EFFORT_WORDS = new Set([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
])

const EFFORT_PATHS = {
  reasoning_effort: 'schema.input.properties.reasoning_effort',
  'reasoning.effort': 'schema.input.properties.reasoning.properties.effort',
  'output_config.effort':
    'schema.input.properties.output_config.properties.effort',
} as const

type EffortWire = keyof typeof EFFORT_PATHS

interface EffortField {
  wire: EffortWire
  efforts: Array<string>
}

interface ParsedReasoning {
  reasoning: ModelReasoning
  wire: EffortWire | null
  path: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fail(rawId: string, message: string): Error {
  return new Error(`cloudflare-ai-gateway: ${rawId} ${message}`)
}

/** Raw catalog-file URLs from a GitHub contents listing. */
export function catalogFileUrls(text: string): Array<string> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('cloudflare-ai-gateway: catalog directory was not JSON')
  }
  if (!Array.isArray(parsed)) {
    throw new Error('cloudflare-ai-gateway: catalog directory was not a list')
  }
  const urls: Array<string> = []
  for (const entry of parsed) {
    if (!isRecord(entry) || entry.type !== 'file') continue
    const url = entry.download_url
    if (
      typeof url !== 'string' ||
      !url.startsWith(RAW_PREFIX) ||
      !url.includes(RAW_DIR) ||
      !url.endsWith('.json')
    ) {
      throw new Error(
        `cloudflare-ai-gateway: catalog file URL was not a docs JSON file`,
      )
    }
    urls.push(url)
  }
  if (urls.length === 0) {
    throw new Error(
      'cloudflare-ai-gateway: catalog directory listed no model files',
    )
  }
  return urls
}

function positiveInt(
  value: unknown,
  rawId: string,
  field: string,
): number | null {
  if (value == null) return null
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw fail(rawId, `${field} is not a positive integer`)
  }
  return value
}

function metaString(
  metadata: Record<string, unknown>,
  key: string,
  rawId: string,
): string | null {
  const value = metadata[key]
  if (value == null) return null
  if (typeof value !== 'string') throw fail(rawId, `${key} was not a string`)
  return value
}

function stringList(
  value: unknown,
  rawId: string,
  field: string,
): Array<string> {
  if (value == null) return []
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === 'string')
  ) {
    throw fail(rawId, `${field} was not a string list`)
  }
  return value
}

function tokenCard(
  pricing: unknown,
  rawId: string,
  source: RateCard['source'],
): RateCard | null {
  if (pricing == null) return null
  if (!isRecord(pricing)) throw fail(rawId, 'pricing was not an object')
  const keys = Object.keys(pricing)
  if (keys.length === 0) return null
  if (keys.some((key) => FLAT_LEVERS[key] === undefined)) return null
  const rates: Record<string, number> = {}
  for (const key of keys) {
    const lever = FLAT_LEVERS[key]
    if (!lever) return null
    const dollars = pricing[key]
    if (
      typeof dollars !== 'number' ||
      !Number.isFinite(dollars) ||
      dollars < 0
    ) {
      throw fail(rawId, `pricing ${key} is not a finite number`)
    }
    rates[lever] = dollars / 1_000_000
  }
  if (rates.input_tokens === undefined || rates.output_tokens === undefined) {
    return null
  }
  return compileTokenCard(rates, [], source)
}

function outputModalities(activity: Activity | null): Array<string> {
  if (activity === 'chat') return ['text']
  if (activity === 'image') return ['image']
  if (activity === 'video') return ['video']
  if (activity === 'audio') return ['audio']
  return []
}

function inputModalities(
  metadata: Record<string, unknown>,
  rawId: string,
  activity: Activity | null,
): { input: Array<string>; output: Array<string>; key: string } | null {
  const key = MODALITY_KEYS.find((name) => metadata[name] != null)
  if (!key) return null
  const value = metaString(metadata, key, rawId)
  if (!value?.trim()) throw fail(rawId, `${key} is not a modality list`)
  const tokens = value
    .toLowerCase()
    .split(/,|\+|\band\b|\bor\b|[()]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  if (tokens.length === 0) throw fail(rawId, `${key} is not a modality list`)
  const input: Array<string> = []
  for (const token of tokens) {
    const mapped = MODALITY_WORDS[token]
    if (!mapped) throw fail(rawId, `${key} has unknown modality ${token}`)
    if (!input.includes(mapped)) input.push(mapped)
  }
  return { input, output: outputModalities(activity), key }
}

function sameEfforts(left: Array<string>, right: Array<string>): boolean {
  if (left.length !== right.length) return false
  const have = new Set(left)
  return right.every((effort) => have.has(effort))
}

function configurableEfforts(
  value: string | null,
  rawId: string,
): Array<string> | null {
  if (!value) return null
  const match = /^Configurable \((.+)\)$/.exec(value.trim())
  const listed = match?.[1]
  if (!listed) return null
  const efforts = listed
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0)
  if (efforts.length === 0) {
    throw fail(rawId, 'Configurable reasoning listed no levels')
  }
  for (const effort of efforts) {
    if (!EFFORT_WORDS.has(effort)) {
      throw fail(rawId, `reasoning level ${effort} is not a known effort`)
    }
  }
  return efforts
}

function describesModelDependent(node: unknown): boolean {
  if (!isRecord(node)) return false
  if (
    typeof node.description === 'string' &&
    node.description.toLowerCase().includes('model-dependent')
  ) {
    return true
  }
  for (const key of ['anyOf', 'oneOf'] as const) {
    const parts = node[key]
    if (Array.isArray(parts) && parts.some(describesModelDependent)) return true
  }
  return false
}

function stringEnums(node: unknown, rawId: string): Array<Array<string>> {
  if (!isRecord(node)) return []
  if (Array.isArray(node.enum)) {
    const values: Array<string> = []
    for (const item of node.enum) {
      if (typeof item !== 'string' || item === '') {
        throw fail(rawId, 'effort enum was not a list of strings')
      }
      values.push(item)
    }
    return [values]
  }
  const parts: Array<unknown> = []
  for (const key of ['anyOf', 'oneOf'] as const) {
    const value = node[key]
    if (!Array.isArray(value)) continue
    for (const part of value) parts.push(part)
  }
  return parts.flatMap((part) => stringEnums(part, rawId))
}

function effortWire(key: string, parentKey: string | null): EffortWire | null {
  if (key === 'reasoning_effort') return 'reasoning_effort'
  if (key === 'effort' && parentKey === 'reasoning') return 'reasoning.effort'
  if (key === 'effort' && parentKey === 'output_config') {
    return 'output_config.effort'
  }
  return null
}

function readEffortField(
  node: unknown,
  wire: EffortWire,
  rawId: string,
): EffortField | null {
  if (describesModelDependent(node)) return null
  const enums = stringEnums(node, rawId)
  const first = enums[0]
  if (!first) return null
  if (enums.some((efforts) => !sameEfforts(efforts, first))) {
    throw fail(rawId, `${wire} lists two effort enums`)
  }
  for (const effort of first) {
    if (!EFFORT_WORDS.has(effort)) {
      throw fail(rawId, `reasoning level ${effort} is not a known effort`)
    }
  }
  return { wire, efforts: first }
}

function collectEffortFields(
  schema: unknown,
  rawId: string,
): Array<EffortField> {
  const found: Array<EffortField> = []
  const visit = (node: unknown, parentKey: string | null, depth: number) => {
    if (!isRecord(node)) return
    if (depth > 40) throw fail(rawId, 'request schema is too deep')
    if (isRecord(node.properties)) {
      for (const [key, child] of Object.entries(node.properties)) {
        const wire = effortWire(key, parentKey)
        if (wire) {
          const field = readEffortField(child, wire, rawId)
          if (field) found.push(field)
        }
        visit(child, key, depth + 1)
      }
    }
    for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
      const variants = node[key]
      if (!Array.isArray(variants)) continue
      for (const variant of variants) visit(variant, parentKey, depth + 1)
    }
    if (node.items) visit(node.items, parentKey, depth + 1)
  }
  visit(schema, null, 0)
  const byWire = new Map<EffortWire, EffortField>()
  for (const field of found) {
    const prior = byWire.get(field.wire)
    if (!prior) {
      byWire.set(field.wire, field)
      continue
    }
    if (!sameEfforts(prior.efforts, field.efforts)) {
      throw fail(rawId, `${field.wire} lists two effort enums`)
    }
  }
  return [...byWire.values()]
}

function thinkingTypeIsAdaptive(node: unknown): boolean | null {
  if (!isRecord(node) || !isRecord(node.properties)) return null
  const typeNode = node.properties.type
  if (!isRecord(typeNode)) return null
  if (typeNode.const === 'adaptive') return true
  if (Array.isArray(typeNode.enum)) {
    return typeNode.enum.length === 1 && typeNode.enum[0] === 'adaptive'
  }
  return false
}

/** True when every `thinking.type` this schema publishes is exactly `adaptive`. */
function adaptiveThinking(schema: unknown, rawId: string): boolean {
  const kinds: Array<'adaptive' | 'other'> = []
  const visit = (node: unknown, key: string | null, depth: number) => {
    if (!isRecord(node)) return
    if (depth > 40) throw fail(rawId, 'request schema is too deep')
    if (key === 'thinking') {
      const kind = thinkingTypeIsAdaptive(node)
      if (kind === true) kinds.push('adaptive')
      else if (kind === false) kinds.push('other')
    }
    if (isRecord(node.properties)) {
      for (const [childKey, child] of Object.entries(node.properties)) {
        visit(child, childKey, depth + 1)
      }
    }
    for (const combo of ['oneOf', 'anyOf', 'allOf'] as const) {
      const variants = node[combo]
      if (!Array.isArray(variants)) continue
      for (const variant of variants) visit(variant, key, depth + 1)
    }
  }
  visit(schema, null, 0)
  return kinds.includes('adaptive') && !kinds.includes('other')
}

function effortReasoning(field: EffortField): ModelReasoning {
  return {
    mode: 'effort',
    mandatory: field.efforts.includes('none') ? false : null,
    efforts: field.efforts,
  }
}

function parsedReasoning(
  metadata: Record<string, unknown>,
  schema: unknown,
  rawId: string,
  schemaShared: boolean,
): ParsedReasoning | null {
  const stated = metaString(metadata, 'Reasoning', rawId)
  if (stated === 'No') return null
  const fields = collectEffortFields(schema, rawId)
  const configured = configurableEfforts(stated, rawId)
  if (configured) {
    const matches = fields.filter((field) =>
      sameEfforts(field.efforts, configured),
    )
    if (matches.length === 0) {
      throw fail(
        rawId,
        'Configurable reasoning does not match the request schema',
      )
    }
    const match = matches[0]
    if (!match || matches.length > 1) return null
    return {
      reasoning: effortReasoning(match),
      wire: match.wire,
      path: 'metadata.Reasoning',
    }
  }
  if (schemaShared) return null
  if (adaptiveThinking(schema, rawId)) {
    const effort = fields.filter(
      (field) => field.wire === 'output_config.effort',
    )
    const others = fields.filter(
      (field) => field.wire !== 'output_config.effort',
    )
    const only = effort[0]
    if (others.length > 0 || effort.length > 1) return null
    if (!only) {
      return {
        reasoning: { mode: 'adaptive', mandatory: true },
        wire: null,
        path: 'schema.input.properties.thinking.type',
      }
    }
    return {
      reasoning: {
        mode: 'adaptive',
        mandatory: only.efforts.includes('none') ? false : true,
        efforts: only.efforts,
      },
      wire: only.wire,
      path: EFFORT_PATHS[only.wire],
    }
  }
  if (fields.length !== 1) return null
  const field = fields[0]
  if (!field) return null
  return {
    reasoning: effortReasoning(field),
    wire: field.wire,
    path: EFFORT_PATHS[field.wire],
  }
}

function maxTokenField(
  schema: unknown,
  rawId: string,
): 'max_tokens' | 'max_completion_tokens' | null {
  const found = new Set<'max_tokens' | 'max_completion_tokens'>()
  const visit = (node: unknown, depth: number) => {
    if (!isRecord(node)) return
    if (depth > 40) throw fail(rawId, 'request schema is too deep')
    if (isRecord(node.properties)) {
      if ('max_tokens' in node.properties) found.add('max_tokens')
      if ('max_completion_tokens' in node.properties) {
        found.add('max_completion_tokens')
      }
      for (const child of Object.values(node.properties))
        visit(child, depth + 1)
    }
    for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
      const variants = node[key]
      if (!Array.isArray(variants)) continue
      for (const variant of variants) visit(variant, depth + 1)
    }
    if (node.items) visit(node.items, depth + 1)
  }
  visit(schema, 0)
  if (found.size !== 1) return null
  return [...found][0] ?? null
}

function objectHasProperties(node: unknown): boolean {
  if (!isRecord(node)) return false
  if (isRecord(node.properties) && Object.keys(node.properties).length > 0) {
    return true
  }
  for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
    const variants = node[key]
    if (Array.isArray(variants) && variants.some(objectHasProperties))
      return true
  }
  return false
}

function unknownArray(value: unknown): Array<unknown> {
  return Array.isArray(value) ? value : []
}

function toolItemsHaveProperties(toolsNode: unknown): boolean {
  if (!isRecord(toolsNode)) return false
  const candidates = [
    toolsNode,
    ...unknownArray(toolsNode.anyOf),
    ...unknownArray(toolsNode.oneOf),
  ]
  return candidates.some(
    (node) => isRecord(node) && objectHasProperties(node.items),
  )
}

function schemaHasTools(schema: unknown): boolean {
  let found = false
  const visit = (node: unknown, key: string | null, depth: number) => {
    if (!isRecord(node) || depth > 40) return
    if (key === 'tools' && toolItemsHaveProperties(node)) found = true
    if (isRecord(node.properties)) {
      for (const [childKey, child] of Object.entries(node.properties)) {
        visit(child, childKey, depth + 1)
      }
    }
    for (const combo of ['oneOf', 'anyOf', 'allOf'] as const) {
      const variants = node[combo]
      if (!Array.isArray(variants)) continue
      for (const variant of variants) visit(variant, key, depth + 1)
    }
  }
  visit(schema, null, 0)
  return found
}

function toolsPath(
  metadata: Record<string, unknown>,
  tags: Array<string>,
  schema: unknown,
  rawId: string,
): string | null {
  if (metaString(metadata, 'Tool Use', rawId) === 'Yes')
    return 'metadata.Tool Use'
  if (metaString(metadata, 'Function Calling', rawId) === 'Yes') {
    return 'metadata.Function Calling'
  }
  if (tags.includes('Tool Use') || tags.includes('Function Calling'))
    return 'tags'
  if (schemaHasTools(schema)) return 'schema.input'
  return null
}

function effortLevels(efforts: Array<string>): EffortLevelMap {
  const off = efforts.includes('none') ? 'none' : null
  return {
    off,
    minimal: efforts.includes('minimal') ? 'minimal' : null,
    low: efforts.includes('low') ? 'low' : null,
    medium: efforts.includes('medium') ? 'medium' : null,
    high: efforts.includes('high') ? 'high' : null,
    xhigh: efforts.includes('xhigh') ? 'xhigh' : null,
    max: efforts.includes('max') ? 'max' : null,
  }
}

function thinkingOn(wire: EffortWire, off: boolean): Record<string, unknown> {
  if (wire === 'reasoning_effort') {
    return { reasoning_effort: off ? 'none' : 'high' }
  }
  if (wire === 'reasoning.effort') {
    return { reasoning: { effort: off ? 'none' : 'high' } }
  }
  return {
    thinking: { type: 'adaptive' },
    output_config: { effort: off ? 'none' : 'high' },
  }
}

function thinkingRequest(parsed: ParsedReasoning): ThinkingRequest | null {
  const efforts = parsed.reasoning.efforts
  if (!parsed.wire || !efforts?.includes('high')) return null
  const canStop =
    parsed.reasoning.mandatory !== true && efforts.includes('none')
  return {
    on: thinkingOn(parsed.wire, false),
    off: canStop ? thinkingOn(parsed.wire, true) : null,
    levels: effortLevels(efforts),
  }
}

function gatewayRequestMap(
  activity: Activity | null,
  maxField: 'max_tokens' | 'max_completion_tokens' | null,
  parsed: ParsedReasoning | null,
): ChatRequestMap | null {
  if (activity !== 'chat') return null
  const thinking = parsed ? thinkingRequest(parsed) : null
  if (maxField === null && thinking === null) return null
  return {
    thinking,
    maxTokensField: maxField,
    developerRole: null,
    replayReasoningContent: null,
    store: null,
    strictTools: null,
    sessionAffinity: null,
    cacheControl: null,
    toolStream: null,
    reasoningEffort: parsed?.wire === 'reasoning_effort' ? true : null,
  }
}

function schemaInput(model: Record<string, unknown>, rawId: string): unknown {
  if (model.schema == null) return null
  if (!isRecord(model.schema)) throw fail(rawId, 'schema was not an object')
  if (model.schema.input == null) return null
  if (!isRecord(model.schema.input)) {
    throw fail(rawId, 'schema.input was not an object')
  }
  return model.schema.input
}

function provenance(source: RateCard['source'], path: string): FactSource {
  return {
    derivation: 'listing',
    sourceUrl: source.url,
    sourceHash: source.hash,
    path,
  }
}

/** One catalog JSON file. `schemaShared` is true when another file has the same input schema. */
export function parseCatalogModel(
  model: unknown,
  source: RateCard['source'],
  options?: { schemaShared?: boolean },
): ModelInfo {
  if (
    !isRecord(model) ||
    typeof model.model_id !== 'string' ||
    !model.model_id.includes('/')
  ) {
    throw new Error('cloudflare-ai-gateway: catalog file listed no model id')
  }
  const rawId = model.model_id
  if (rawId.startsWith('@')) throw fail(rawId, 'catalog file is Workers AI')
  const displayName = metaString({ name: model.name }, 'name', rawId)
  const task = metaString({ task: model.task }, 'task', rawId)
  const activity = task ? (TASK_ACTIVITY[task] ?? null) : null
  const metadata = model.metadata == null ? {} : model.metadata
  if (!isRecord(metadata)) throw fail(rawId, 'metadata was not an object')
  const tags = stringList(model.tags, rawId, 'tags')
  const schema = schemaInput(model, rawId)
  const schemaShared = options?.schemaShared === true
  const modalities = inputModalities(metadata, rawId, activity)
  const parsed = parsedReasoning(metadata, schema, rawId, schemaShared)
  const requestMap = gatewayRequestMap(
    activity,
    maxTokenField(schema, rawId),
    parsed,
  )
  const tools = toolsPath(metadata, tags, schema, rawId)
  const structured = tags.includes('Structured Output')
  const reasons =
    parsed !== null ||
    tags.includes('Reasoning') ||
    metaString(metadata, 'Adaptive Thinking', rawId) === 'Yes'
  const capabilities = [
    ...(tools ? ['tools'] : []),
    ...(structured ? ['structured_outputs'] : []),
    ...(reasons ? ['reasoning'] : []),
  ]
  const contextWindow = positiveInt(
    model.context_length,
    rawId,
    'context_length',
  )
  const maxOutput = positiveInt(
    model.max_output_tokens,
    rawId,
    'max_output_tokens',
  )
  const pricing = tokenCard(model.pricing, rawId, source)
  const cited = (path: string) => provenance(source, path)
  const flagPath = (flag: string): string => {
    if (flag === 'tools' && tools) return tools
    if (flag === 'reasoning') {
      if (parsed) return parsed.path
      if (!tags.includes('Reasoning')) return 'metadata.Adaptive Thinking'
    }
    return 'tags'
  }
  return {
    rawId,
    displayName,
    activity,
    contextWindow,
    maxOutput,
    ...(modalities
      ? { modalities: { input: modalities.input, output: modalities.output } }
      : {}),
    pricing,
    ...(capabilities.length > 0 ? { capabilities } : {}),
    ...(parsed ? { reasoning: parsed.reasoning } : {}),
    ...(requestMap ? { requestMap } : {}),
    factSources: {
      ...(contextWindow != null
        ? { contextWindow: cited('context_length') }
        : {}),
      ...(maxOutput != null ? { maxOutput: cited('max_output_tokens') } : {}),
      ...(modalities
        ? { modalities: cited(`metadata.${modalities.key}`) }
        : {}),
      ...(pricing ? { pricing: cited('pricing') } : {}),
      ...(capabilities.length > 0
        ? {
            capabilities: Object.fromEntries(
              capabilities.map((flag) => [flag, cited(flagPath(flag))]),
            ),
          }
        : {}),
      ...(parsed ? { reasoning: cited(parsed.path) } : {}),
    },
  }
}

function schemaHashInput(model: unknown): unknown {
  if (!isRecord(model) || !isRecord(model.schema)) return null
  return model.schema.input ?? null
}

async function loadCatalog(env: ProviderSecrets, kv?: KVNamespace) {
  const urls = await cachedDocs(kv, CATALOG_DIR_URL, async () =>
    catalogFileUrls(
      await fetchText(
        CATALOG_DIR_URL,
        githubRequestInit(CATALOG_DIR_URL, env, { headers: GITHUB_HEADERS }),
      ),
    ),
  )
  const loaded = await mapConcurrent(urls, 8, async (url) => {
    const doc = await cachedDocs(kv, url, async () => {
      const text = await fetchText(
        url,
        githubRequestInit(url, env, { headers: GITHUB_HEADERS }),
      )
      return {
        text,
        hash: await sha256Text(text),
        extractedAt: new Date().toISOString(),
      }
    })
    let model: unknown
    try {
      model = JSON.parse(doc.text)
    } catch {
      throw new Error(`cloudflare-ai-gateway: ${url} was not JSON`)
    }
    return {
      url,
      model,
      source: { url, hash: doc.hash, extractedAt: doc.extractedAt },
      schemaHash: await sha256Text(JSON.stringify(schemaHashInput(model))),
    }
  })
  return loaded
}

async function listModels(
  env: ProviderSecrets,
  kv?: KVNamespace,
): Promise<ListModelsResult> {
  const loaded = await loadCatalog(env, kv)
  const shared = new Map<string, number>()
  for (const row of loaded) {
    shared.set(row.schemaHash, (shared.get(row.schemaHash) ?? 0) + 1)
  }
  const models = loaded.map((row) =>
    parseCatalogModel(row.model, row.source, {
      schemaShared: (shared.get(row.schemaHash) ?? 0) > 1,
    }),
  )
  const seen = new Set<string>()
  for (const model of models) {
    if (seen.has(model.rawId)) {
      throw new Error(
        `cloudflare-ai-gateway: duplicate model id ${model.rawId}`,
      )
    }
    seen.add(model.rawId)
  }
  return { models }
}

async function fetchSpec(env: ProviderSecrets): Promise<SpecFetchResult> {
  const text = await fetchText(GATEWAY_REST_DOCS, {
    signal: AbortSignal.timeout(30_000),
  })
  const source = { url: GATEWAY_REST_DOCS, hash: await sha256Text(text) }
  const contract = parseGatewayRunContract(text, source)
  const loaded = await loadCatalog(env)
  const bundledEndpoints = []
  const warnings: Array<string> = []
  const seen = new Set<string>()
  for (const row of loaded) {
    const info = parseCatalogModel(row.model, row.source, {
      schemaShared: true,
    })
    if (seen.has(info.rawId))
      throw new Error(`cloudflare-ai-gateway: duplicate model id ${info.rawId}`)
    seen.add(info.rawId)
    const endpoint = catalogGatewayEndpoint(
      row.model,
      info,
      row.source,
      contract,
    )
    if (endpoint) bundledEndpoints.push(endpoint)
    else
      warnings.push(
        `${info.rawId}: native activity or input schema unpublished; no schema endpoint`,
      )
  }
  if (bundledEndpoints.length === 0)
    throw new Error(
      'cloudflare-ai-gateway: catalog published no classifiable input schemas',
    )
  return {
    specs: [],
    sources: [],
    outputStrategy: 'post-200',
    bundledEndpoints,
    warnings,
  }
}

export const provider: ProviderConfig = {
  id: 'cloudflare-ai-gateway',
  displayName: 'Cloudflare AI Gateway',
  specSourceUrl: CATALOG_URL,
  modelsEndpoint: CATALOG_URL,
  defaultDerivation: 'docs-derived',
  bindSyncedRoutesOnly: true,
  specGrain: 'model',
  connect: bearerConnect('https://api.cloudflare.com/client/v4'),
  fetchSpec,
  listModels,
  classify: () => null,
}
