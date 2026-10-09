/**
 * Per-model OpenAPI documents NVIDIA publishes on docs.api.nvidia.com.
 * Each reference index row names a listing id and its infer page. The
 * infer page embeds one OpenAPI document for that model. A shared
 * `/chat/completions` path would keep only the last model's schema, so
 * the public endpoint identity is the model's own id; the wire path remains native. A document that names a different
 * model is not that row's schema.
 */
import type { ChatRequestMap } from './request-map.ts'
import type { Activity } from '#/db/schema.ts'

import type {
  ModelReasoning,
  OpenApiDocument,
  OpenApiOperation,
} from './types.ts'

export const NVIDIA_REFERENCE_INDEXES = [
  'https://docs.api.nvidia.com/nim/reference/llm-apis.md',
  'https://docs.api.nvidia.com/nim/reference/retrieval-apis.md',
  'https://docs.api.nvidia.com/nim/reference/multimodal-apis.md',
  'https://docs.api.nvidia.com/nim/reference/visual-models-apis.md',
]

/** Set on the copied operation so classify still sees the real route. */
export const NVIDIA_ACTIVITY_MARKER = 'x-modelschemas-activity'

const DOC_TIMEOUT_MS = 60_000
const MAX_OUTPUT_CAP = 10_000_000

export interface NvidiaIndexRow {
  rawId: string
  inferUrl: string
}

export interface NvidiaInferFacts {
  document: OpenApiDocument
  activity: Activity | null
  maxOutput?: number
  reasoning?: ModelReasoning
  reasoningField?: string
  maxOutputField?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isChallenge(text: string): boolean {
  return (
    text.includes('Just a moment') ||
    text.includes('cf-browser-verification') ||
    text.includes('Attention Required')
  )
}

/** Fetch one NVIDIA docs page. A 429 is retried; a challenge is not a spec. */
export async function fetchNvidiaText(url: string): Promise<string> {
  let last = 'no response'
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await delay(800 * 2 ** (attempt - 1))
    const response = await fetch(url, {
      headers: {
        accept: 'text/markdown,application/json;q=0.9,*/*;q=0.8',
        'user-agent': 'modelschemas',
      },
      signal: AbortSignal.timeout(DOC_TIMEOUT_MS),
    })
    // 429 and a challenge page are the same Cloudflare throttle. A 503
    // is that document failing; retrying it stalls the rest of the poll.
    if (response.status === 429) {
      last = String(response.status)
      continue
    }
    const text = await response.text()
    if (!response.ok) {
      throw new Error(
        `fetch failed: ${url} → ${String(response.status)} ${response.statusText}`,
      )
    }
    if (isChallenge(text)) {
      last = 'cloudflare challenge'
      continue
    }
    return text
  }
  throw new Error(`nvidia: ${url} rate limited (${last})`)
}

function absoluteReference(href: string): string | null {
  if (href.startsWith('ref:')) {
    return `https://docs.api.nvidia.com/nim/reference/${href.slice('ref:'.length)}`
  }
  if (href.startsWith('https://docs.api.nvidia.com/nim/reference/')) return href
  return null
}

/** Infer or invoke page for an index endpoint cell. Status polls are not specs. */
function inferUrlFromCell(cell: string): string | null {
  const links = [...cell.matchAll(/\[[^\]]*]\(([^)]+)\)/g)].map((match) =>
    absoluteReference(match[1] ?? ''),
  )
  const direct = links.find(
    (href) => href?.endsWith('-infer') || href?.endsWith('-invoke'),
  )
  if (direct) return direct
  const page = links.find((href) => href && !href.endsWith('-statuspolling'))
  return page ? `${page}-infer` : null
}

/**
 * Rows of one reference index. Link text `publisher / id` is the listing
 * id once the spaces NVIDIA inserts are removed (`moonshot ai / kimi-k2.6`).
 * A markdown page whose model table yields nothing throws.
 */
export function parseNvidiaReferenceIndex(
  markdown: string,
): Array<NvidiaIndexRow> {
  if (!markdown.startsWith('---\n')) {
    throw new Error('nvidia: reference index is not markdown')
  }
  const rows: Array<NvidiaIndexRow> = []
  const seen = new Set<string>()
  let tableRows = 0
  for (const line of markdown.split('\n')) {
    if (!line.startsWith('|')) continue
    const cells = line.split('|').slice(1, -1)
    if (cells.length < 2) continue
    const modelCell = cells[0] ?? ''
    const endpointCell = cells[1] ?? ''
    if (/^\s*:?-+/.test(modelCell)) continue
    const label = modelCell.match(/\[([^\]]+)]\([^)]+\)/)?.[1]
    if (!label || label.trim().toLowerCase() === 'model') continue
    tableRows++
    const rawId = label.replace(/\s*\/\s*/, '/').replace(/\s+/g, '')
    const inferUrl = inferUrlFromCell(endpointCell)
    if (!inferUrl || seen.has(rawId)) continue
    seen.add(rawId)
    rows.push({ rawId, inferUrl })
  }
  if (tableRows > 0 && rows.length === 0) {
    throw new Error('nvidia: reference index table parsed no models')
  }
  return rows
}

function isOpenApiDocument(value: unknown): value is OpenApiDocument {
  if (!isRecord(value) || typeof value.openapi !== 'string') return false
  if (!isRecord(value.paths)) return false
  return Object.values(value.paths).every(
    (operations) =>
      isRecord(operations) &&
      Object.values(operations).every((operation) => isRecord(operation)),
  )
}

function extractOpenApi(markdown: string): OpenApiDocument | null {
  const section = markdown.split('# OpenAPI definition')[1] ?? markdown
  for (const match of section.matchAll(/```json\s*/g)) {
    try {
      const start = match.index + match[0].length
      let depth = 0,
        quoted = false,
        escaped = false
      for (let end = start; end < section.length; end++) {
        const char = section[end]
        if (quoted) {
          if (escaped) escaped = false
          else if (char === '\\') escaped = true
          else if (char === '"') quoted = false
        } else if (char === '"') quoted = true
        else if (char === '{') depth++
        else if (char === '}' && --depth === 0) {
          const parsed: unknown = JSON.parse(section.slice(start, end + 1))
          if (isOpenApiDocument(parsed)) return parsed
          break
        }
      }
    } catch {
      // An example fence is not the document.
    }
  }
  return null
}

function deref(
  doc: OpenApiDocument,
  node: unknown,
  depth: number,
): Record<string, unknown> | null {
  if (depth > 8 || !isRecord(node)) return null
  const ref = node.$ref
  if (typeof ref !== 'string' || !ref.startsWith('#/components/schemas/')) {
    return node
  }
  const schemas = doc.components?.schemas
  if (!isRecord(schemas)) return node
  const target = schemas[ref.slice('#/components/schemas/'.length)]
  return deref(doc, target, depth + 1)
}

function requestProperties(doc: OpenApiDocument): Record<string, unknown> {
  const collect = (node: unknown, depth: number): Record<string, unknown> => {
    const resolved = deref(doc, node, depth)
    if (!resolved) return {}
    const own = isRecord(resolved.properties) ? resolved.properties : {}
    const out: Record<string, unknown> = { ...own }
    for (const key of ['allOf', 'anyOf', 'oneOf']) {
      const list = resolved[key]
      if (!Array.isArray(list)) continue
      for (const item of list) Object.assign(out, collect(item, depth + 1))
    }
    return out
  }
  const out: Record<string, unknown> = {}
  for (const operations of Object.values(doc.paths ?? {})) {
    if (!isRecord(operations) || !isRecord(operations.post)) continue
    const requestBody = operations.post.requestBody
    if (!isRecord(requestBody) || !isRecord(requestBody.content)) continue
    const json = requestBody.content['application/json']
    if (!isRecord(json)) continue
    Object.assign(out, collect(json.schema, 0))
  }
  return out
}

function integerMaximum(node: unknown): number | null {
  if (!isRecord(node)) return null
  if (
    typeof node.maximum === 'number' &&
    Number.isInteger(node.maximum) &&
    node.maximum >= 1 &&
    node.maximum <= MAX_OUTPUT_CAP &&
    node.type !== 'number'
  ) {
    return node.maximum
  }
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    const list = node[key]
    if (!Array.isArray(list)) continue
    for (const item of list) {
      const found = integerMaximum(item)
      if (found !== null) return found
    }
  }
  return null
}

/** `max_tokens` / `max_completion_tokens` maximum: tokens to generate. */
export function nvidiaMaxOutput(doc: OpenApiDocument): number | undefined {
  const props = requestProperties(doc)
  for (const name of ['max_tokens', 'max_completion_tokens']) {
    const cap = integerMaximum(props[name])
    if (cap !== null) return cap
  }
  return undefined
}

function enumStrings(node: unknown): Array<string> | null {
  if (!isRecord(node)) return null
  if (Array.isArray(node.enum)) {
    const values = node.enum.flatMap((item) =>
      typeof item === 'string' ? [item] : [],
    )
    if (values.length > 0 && values.length === node.enum.length) return values
  }
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    const list = node[key]
    if (!Array.isArray(list)) continue
    const strings = list.flatMap((item) => enumStrings(item) ?? [])
    if (strings.length > 0) return strings
  }
  return null
}

function isBooleanSchema(node: unknown): boolean {
  if (!isRecord(node)) return false
  if (node.type === 'boolean') return true
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    const list = node[key]
    if (Array.isArray(list) && list.some((item) => isBooleanSchema(item)))
      return true
  }
  return false
}

function statesOnAndOff(node: unknown): boolean {
  if (!isRecord(node) || typeof node.description !== 'string') return false
  const text = node.description
  return (
    /enable_thinking|\bthinking\b/i.test(text) &&
    /true/i.test(text) &&
    /false/i.test(text)
  )
}

/** An enum label alone does not establish the model's disabling semantics. */
function nativeEffortDisablesReasoning(
  node: unknown,
  efforts: string[],
): boolean {
  if (!isRecord(node) || typeof node.description !== 'string') return false
  const prose = node.description.replace(/```[\s\S]*?```/g, '')
  if (/\b(?:not|no|never|cannot|without|doesn't)\b/i.test(prose)) return false
  return efforts.some(
    (level) =>
      /^(none|off|disabled)$/i.test(level) &&
      new RegExp(
        '(?:^|\\W)' +
          level +
          '[`"\']?\\s+(?:explicitly\\s+)?(?:disables?|turns?\\s+off)\\s+(?:reasoning|thinking)\\b',
        'i',
      ).test(prose),
  )
}

/**
 * Reasoning control on this model's own request schema. An effort enum
 * wins over a budget, and a budget wins over an on/off switch. An enum
 * requires native disabling semantics before mandatory becomes false. A boolean states both positions, so
 * the toggle is not mandatory.
 */
export function nvidiaReasoning(
  doc: OpenApiDocument,
): ModelReasoning | undefined {
  const props = requestProperties(doc)
  const efforts = enumStrings(props.reasoning_effort)
  if (efforts && efforts.length > 0) {
    return {
      mode: 'effort',
      mandatory: nativeEffortDisablesReasoning(props.reasoning_effort, efforts)
        ? false
        : null,
      efforts,
    }
  }
  if (props.reasoning_budget !== undefined) {
    return { mode: 'budget', mandatory: null }
  }
  const template = deref(doc, props.chat_template_kwargs, 0)
  const templateProperties = isRecord(template?.properties)
    ? template.properties
    : {}
  const toggle =
    isBooleanSchema(props.enable_thinking) ||
    isBooleanSchema(templateProperties.enable_thinking) ||
    statesOnAndOff(props.chat_template_kwargs) ||
    statesOnAndOff(props.enable_thinking)
  if (toggle) return { mode: 'toggle', mandatory: false }
  return undefined
}

function activityForPath(path: string): Activity | null {
  if (path.includes('chat/completions')) return 'chat'
  if (path.includes('/embeddings')) return 'embeddings'
  if (/(^|\/)completions$/.test(path)) return 'chat'
  return null
}

/**
 * Native request selectors identify the serving model. OpenAPI info.title
 * names the API, so it is only identity evidence when no selector is published.
 * Every literal selector must agree; no aliases are normalized.
 */
export function nvidiaStatedModelIds(doc: OpenApiDocument): Array<string> {
  const ids = new Set<string>()
  const selectors = (node: unknown, depth: number): void => {
    const model = deref(doc, node, depth)
    if (!model) return
    const add = (value: unknown) => {
      if (typeof value === 'string' && value.trim()) ids.add(value.trim())
    }
    add(model.const)
    add(model.default)
    if (Array.isArray(model.enum)) for (const value of model.enum) add(value)
    for (const key of ['allOf', 'anyOf', 'oneOf']) {
      if (Array.isArray(model[key]))
        for (const value of model[key]) selectors(value, depth + 1)
    }
  }
  const request = (node: unknown, depth: number): void => {
    const schema = deref(doc, node, depth)
    if (!schema) return
    if (isRecord(schema.properties))
      selectors(schema.properties.model, depth + 1)
    for (const key of ['allOf', 'anyOf', 'oneOf']) {
      if (Array.isArray(schema[key]))
        for (const value of schema[key]) request(value, depth + 1)
    }
  }
  for (const operations of Object.values(doc.paths ?? {})) {
    if (!isRecord(operations) || !isRecord(operations.post)) continue
    const body = operations.post.requestBody
    if (!isRecord(body) || !isRecord(body.content)) continue
    const json = body.content['application/json']
    if (isRecord(json)) request(json.schema, 0)
  }
  if (ids.size) return [...ids]
  const title = doc.info?.title
  const named =
    typeof title === 'string'
      ? title
          .trim()
          .match(
            /^(?:NVIDIA NIM API for )?([a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*)$/i,
          )?.[1]
      : undefined
  return named ? [named] : []
}

/** True when every stated id is this listing id, or the document names none. */
export function nvidiaInferNamesModel(
  rawId: string,
  doc: OpenApiDocument,
): boolean {
  const stated = nvidiaStatedModelIds(doc)
  return stated.length === 0 || stated.every((id) => id === rawId)
}

export function parseNvidiaInfer(markdown: string): NvidiaInferFacts | null {
  const document = extractOpenApi(markdown)
  return nvidiaFactsFromDocument(document)
}

/** Parse native JSON directly; descriptions may themselves contain Markdown fences. */
export function nvidiaFactsFromDocument(
  value: unknown,
): NvidiaInferFacts | null {
  if (!isOpenApiDocument(value)) return null
  const document = value
  const paths = Object.keys(document.paths ?? {})
  const activity =
    paths.map(activityForPath).find((item) => item !== null) ?? null
  const maxOutput = nvidiaMaxOutput(document)
  const reasoning = nvidiaReasoning(document)
  const props = requestProperties(document)
  const maxOutputField = ['max_tokens', 'max_completion_tokens'].find(
    (key) => integerMaximum(props[key]) !== null,
  )
  const template = deref(document, props.chat_template_kwargs, 0)
  const templateProperties = isRecord(template?.properties)
    ? template.properties
    : {}
  const reasoningField =
    reasoning?.mode === 'effort'
      ? 'reasoning_effort'
      : reasoning?.mode === 'budget'
        ? 'reasoning_budget'
        : reasoning?.mode === 'toggle'
          ? props.enable_thinking
            ? 'enable_thinking'
            : templateProperties.enable_thinking
              ? 'chat_template_kwargs.enable_thinking'
              : 'chat_template_kwargs.description'
          : undefined
  return {
    document,
    activity,
    ...(maxOutput !== undefined ? { maxOutput } : {}),
    ...(reasoning ? { reasoning, reasoningField } : {}),
    ...(maxOutputField ? { maxOutputField } : {}),
  }
}

/** Only published per-model request members can supply caller wire facts. */
export function nvidiaWireFacts(doc: OpenApiDocument): {
  fields: Partial<ChatRequestMap>
  paths: Partial<Record<keyof ChatRequestMap, string>>
} {
  const props = requestProperties(doc)
  const fields: Partial<ChatRequestMap> = {}
  const paths: Partial<Record<keyof ChatRequestMap, string>> = {}
  const tokenField = ['max_completion_tokens', 'max_tokens'].find(
    (key) => props[key] !== undefined,
  )
  if (tokenField === 'max_tokens' || tokenField === 'max_completion_tokens') {
    fields.maxTokensField = tokenField
    paths.maxTokensField = tokenField
  }
  const roles = (node: unknown, depth = 0): string[] | null => {
    const resolved = deref(doc, node, depth)
    if (!resolved) return null
    if (Array.isArray(resolved.enum)) {
      if (
        !resolved.enum.length ||
        !resolved.enum.every((item) => typeof item === 'string')
      )
        throw new Error('nvidia: unreadable native role enum')
      return resolved.enum
    }
    if (typeof resolved.const === 'string') return [resolved.const]
    if (Array.isArray(resolved.allOf)) {
      const results = resolved.allOf.map((item) => roles(item, depth + 1))
      if (!results.length || !results.every((item) => item !== null))
        return null
      return results[0]!.filter((value) =>
        results.every((list) => list.includes(value)),
      )
    }
    for (const key of ['anyOf', 'oneOf']) {
      const alternatives = resolved[key]
      if (!Array.isArray(alternatives)) continue
      const results = alternatives
        .filter((item) => !isRecord(item) || item.type !== 'null')
        .map((item) => roles(item, depth + 1))
      return results.length && results.every((item) => item !== null)
        ? results.flatMap((item) => item)
        : null
    }
    return null
  }
  const messageRoles = (node: unknown, depth = 0): string[] | null => {
    const message = deref(doc, node, depth)
    if (!message) return null
    if (isRecord(message.properties) && message.properties.role !== undefined)
      return roles(message.properties.role, depth + 1)
    for (const key of ['anyOf', 'oneOf']) {
      const alternatives = message[key]
      if (!Array.isArray(alternatives)) continue
      const results = alternatives.map((item) => messageRoles(item, depth + 1))
      return results.length && results.every((item) => item !== null)
        ? results.flatMap((item) => item)
        : null
    }
    return null
  }
  const messages = deref(doc, props.messages, 0)
  const acceptedRoles = messages ? messageRoles(messages.items) : null
  if (acceptedRoles) {
    fields.developerRole = acceptedRoles.includes('developer')
    paths.developerRole = 'messages.items.role'
  }
  if (props.reasoning_effort !== undefined) {
    fields.reasoningEffort = true
    paths.reasoningEffort = 'reasoning_effort'
    const high = enumStrings(props.reasoning_effort)?.find(
      (value) => value === 'high',
    )
    if (high) {
      fields.thinking = {
        on: { reasoning_effort: high },
        off: null,
        levels: null,
      }
      paths.thinking = 'reasoning_effort'
    }
  }
  const template = deref(doc, props.chat_template_kwargs, 0)
  const nested = isRecord(template?.properties) ? template.properties : {}
  if (!fields.thinking && isBooleanSchema(props.enable_thinking)) {
    fields.thinking = {
      on: { enable_thinking: true },
      off: { enable_thinking: false },
      levels: null,
    }
    paths.thinking = 'enable_thinking'
  } else if (!fields.thinking && isBooleanSchema(nested.enable_thinking)) {
    fields.thinking = {
      on: { chat_template_kwargs: { enable_thinking: true } },
      off: { chat_template_kwargs: { enable_thinking: false } },
      levels: null,
    }
    paths.thinking = 'chat_template_kwargs.enable_thinking'
  }
  return { fields, paths }
}

/**
 * Preserve the native generation path and request/response document.
 * Logical model identity belongs to the bundled endpoint publicId.
 */
export function nvidiaModelSpec(
  _rawId: string,
  facts: NvidiaInferFacts,
): OpenApiDocument | null {
  if (!facts.activity) return null
  for (const [path, operations] of Object.entries(facts.document.paths ?? {})) {
    if (activityForPath(path) !== facts.activity) continue
    const post = operations.post
    if (!post) continue
    return {
      ...facts.document,
      paths: {
        [path]: {
          post: {
            ...post,
            [NVIDIA_ACTIVITY_MARKER]: facts.activity,
          },
        },
      },
    }
  }
  return null
}

export function classifyNvidiaOperation(
  path: string,
  operation: OpenApiOperation,
): Activity | null {
  const marked = operation[NVIDIA_ACTIVITY_MARKER]
  if (
    marked === 'chat' ||
    marked === 'embeddings' ||
    marked === 'image' ||
    marked === 'video' ||
    marked === 'audio' ||
    marked === 'moderation'
  ) {
    return marked
  }
  return activityForPath(path)
}
