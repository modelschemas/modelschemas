/**
 * Per-model OpenAPI documents NVIDIA publishes on docs.api.nvidia.com.
 * Each reference index row names a listing id and its infer page. The
 * infer page embeds one OpenAPI document for that model. A shared
 * `/chat/completions` path would keep only the last model's schema, so
 * the synced path is the model's own id.
 */
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
const OFF_EFFORT = /^(none|off|disabled)$/i

export interface NvidiaIndexRow {
  rawId: string
  inferUrl: string
}

export interface NvidiaInferFacts {
  document: OpenApiDocument
  activity: Activity | null
  maxOutput?: number
  reasoning?: ModelReasoning
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
  for (const match of section.matchAll(/```json\s*([\s\S]*?)```/g)) {
    try {
      const parsed: unknown = JSON.parse(match[1] ?? '')
      if (isOpenApiDocument(parsed)) return parsed
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

/**
 * Reasoning control on this model's own request schema. An effort enum
 * wins over a budget, and a budget wins over an on/off switch. `none` /
 * `off` in the enum is the off value. A boolean states both positions, so
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
      mandatory: efforts.some((effort) => OFF_EFFORT.test(effort))
        ? false
        : null,
      efforts,
    }
  }
  if (props.reasoning_budget !== undefined) {
    return { mode: 'budget', mandatory: null }
  }
  const toggle =
    isBooleanSchema(props.enable_thinking) ||
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

export function parseNvidiaInfer(markdown: string): NvidiaInferFacts | null {
  const document = extractOpenApi(markdown)
  if (!document) return null
  const paths = Object.keys(document.paths ?? {})
  const activity =
    paths.map(activityForPath).find((item) => item !== null) ?? null
  const maxOutput = nvidiaMaxOutput(document)
  const reasoning = nvidiaReasoning(document)
  return {
    document,
    activity,
    ...(maxOutput !== undefined ? { maxOutput } : {}),
    ...(reasoning ? { reasoning } : {}),
  }
}

/**
 * One document whose only generation path is `/${rawId}`. The operation
 * is the model's real POST, including its request schema.
 */
export function nvidiaModelSpec(
  rawId: string,
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
        [`/${rawId}`]: {
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
