/**
 * Schema extraction + bundling (PLAN.md task 2.2) — ported from PR #622's
 * generate-endpoint-maps.ts, minus codegen: pure JSON manipulation, so it
 * runs on Workers.
 *
 * Given an OpenAPI document and an endpoint path, extract the input schema
 * (request body) and output schema, then inline the `$ref` closure under
 * `$defs` so every schema is fully self-contained.
 */
import type { OpenApiDocument } from '#/server/providers/types.ts'

/**
 * Version of the extraction pipeline (classification + bundling), recorded
 * on every schema_versions row. Bump whenever a change here or in a
 * provider's classify/fetchSpec could alter derived schemas — it tells
 * verifiers which extractor produced a stored hash.
 */
export const EXTRACTOR_VERSION = '1'

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: JsonValue }
  | Array<JsonValue>

const COMPONENT_REF_PREFIX = '#/components/schemas/'
const DEFS_REF_PREFIX = '#/$defs/'

export type OutputStrategy = 'post-200' | 'sibling-get'

export interface BundleResult {
  schema: Record<string, JsonValue>
  warnings: Array<string>
}

export interface ExtractedEndpointSchemas {
  /** Bundled, self-contained input schema; absent when the endpoint has no JSON/multipart body. */
  input?: Record<string, JsonValue>
  /** Bundled output schema; absent for binary-media endpoints (TTS audio, …). */
  output?: Record<string, JsonValue>
  warnings: Array<string>
}

function isObject(node: unknown): node is Record<string, JsonValue> {
  return typeof node === 'object' && node !== null && !Array.isArray(node)
}

function collectComponentRefs(node: unknown, into: Set<string>): void {
  if (typeof node !== 'object' || node === null) return
  if (Array.isArray(node)) {
    for (const value of node) collectComponentRefs(value, into)
    return
  }
  for (const [key, value] of Object.entries(node)) {
    if (
      key === '$ref' &&
      typeof value === 'string' &&
      value.startsWith(COMPONENT_REF_PREFIX)
    ) {
      into.add(value.slice(COMPONENT_REF_PREFIX.length))
    } else {
      collectComponentRefs(value, into)
    }
  }
}

/**
 * Rewrite component refs to their bundled location: refs to `rootName`
 * become `#` (the schema itself — the PR let these dangle in $defs), all
 * others move under `#/$defs/`.
 */
function rewriteRefs(node: JsonValue, rootName: string | null): JsonValue {
  if (typeof node !== 'object' || node === null) return node
  if (Array.isArray(node)) return node.map((v) => rewriteRefs(v, rootName))
  const out: Record<string, JsonValue> = {}
  for (const [key, value] of Object.entries(node)) {
    if (
      key === '$ref' &&
      typeof value === 'string' &&
      value.startsWith(COMPONENT_REF_PREFIX)
    ) {
      const refName = value.slice(COMPONENT_REF_PREFIX.length)
      out[key] =
        rootName !== null && refName === rootName
          ? '#'
          : DEFS_REF_PREFIX + refName
    } else {
      out[key] = rewriteRefs(value, rootName)
    }
  }
  return out
}

/**
 * Bundle a schema with its full `$ref` closure under `$defs`.
 *
 * `rootName` is the components key the root schema lives under (null for
 * inline schemas); refs back to it are rewritten to `#`.
 *
 * Dedup-rename lesson from PR #622: when colliding schemas are renamed with
 * a `-2` suffix, refs may say `Name-2` while the components key was
 * sanitised to `Name_2` — resolve through the underscore alias so those
 * defs don't dangle.
 */
export function bundleSchema(
  root: JsonValue,
  components: Record<string, JsonValue>,
  rootName: string | null,
  context: string,
): BundleResult {
  const warnings: Array<string> = []
  const resolveSchema = (refName: string): JsonValue | undefined =>
    components[refName] ?? components[refName.replace(/-/g, '_')]

  const closure = new Set<string>()
  const queue: Array<string> = []
  const seedRefs = new Set<string>()
  collectComponentRefs(root, seedRefs)
  for (const ref of seedRefs) {
    if (ref !== rootName) queue.push(ref)
  }
  while (queue.length > 0) {
    const current = queue.shift()
    if (current === undefined || closure.has(current)) continue
    closure.add(current)
    const target = resolveSchema(current)
    if (target === undefined) {
      warnings.push(
        `${context}: ref target '${current}' not found (transitively referenced)`,
      )
      continue
    }
    const subRefs = new Set<string>()
    collectComponentRefs(target, subRefs)
    for (const ref of subRefs) {
      if (ref !== rootName && !closure.has(ref)) queue.push(ref)
    }
  }

  const rewrittenRoot = rewriteRefs(root, rootName)
  const schema = isObject(rewrittenRoot) ? rewrittenRoot : { ...{} }
  if (!isObject(rewrittenRoot)) {
    warnings.push(`${context}: root schema is not an object`)
    return { schema, warnings }
  }
  if (closure.size === 0) return { schema, warnings }

  const defs: Record<string, JsonValue> = {}
  for (const refName of [...closure].sort()) {
    const target = resolveSchema(refName)
    if (target === undefined) continue
    defs[refName] = rewriteRefs(target, rootName)
  }
  return { schema: { ...schema, $defs: defs }, warnings }
}

interface MediaContent {
  schema?: JsonValue
}

interface OperationShape {
  requestBody?: { content?: Record<string, MediaContent> }
  responses?: Record<string, { content?: Record<string, MediaContent> }>
}

function schemaComponents(spec: OpenApiDocument): Record<string, JsonValue> {
  return (spec.components?.schemas ?? {}) as Record<string, JsonValue>
}

/**
 * Resolve a content node to (root schema, rootName). A `$ref` schema
 * resolves through components; an inline schema is used as-is.
 */
function resolveContentSchema(
  content: MediaContent | undefined,
  components: Record<string, JsonValue>,
  context: string,
  warnings: Array<string>,
): { root: JsonValue; rootName: string | null } | undefined {
  const schema = content?.schema
  if (schema === undefined) return undefined
  if (isObject(schema) && typeof schema.$ref === 'string') {
    if (!schema.$ref.startsWith(COMPONENT_REF_PREFIX)) {
      warnings.push(`${context}: unsupported ref '${schema.$ref}'`)
      return undefined
    }
    const rootName = schema.$ref.slice(COMPONENT_REF_PREFIX.length)
    const root = components[rootName] ?? components[rootName.replace(/-/g, '_')]
    if (root === undefined) {
      warnings.push(`${context}: root ref '${rootName}' not found`)
      return undefined
    }
    return { root, rootName }
  }
  return { root: schema, rootName: null }
}

/**
 * Extract + bundle the input/output schemas for one endpoint.
 *
 * Input: request body — `application/json`, falling back to
 * `multipart/form-data` (media endpoints take multipart uploads whose
 * fields are described by an ordinary schema; the PR's multipart fix).
 *
 * Output:
 * - 'post-200': first success response (200/201/202 — ElevenLabs dubbing
 *   acks with 201, OpenRouter video jobs with 202) carrying a JSON schema.
 * - 'sibling-get': the sibling GET `${path}/requests/{request_id}` 200
 *   response (FAL: the POST returns a queue ack).
 */
export function extractEndpointSchemas(
  spec: OpenApiDocument,
  pathKey: string,
  strategy: OutputStrategy = 'post-200',
): ExtractedEndpointSchemas {
  const warnings: Array<string> = []
  const components = schemaComponents(spec)
  const post = spec.paths?.[pathKey]?.post as OperationShape | undefined
  if (!post) return { warnings }

  let input: Record<string, JsonValue> | undefined
  const requestContent = post.requestBody?.content
  const inputResolved = resolveContentSchema(
    requestContent?.['application/json'] ??
      requestContent?.['multipart/form-data'],
    components,
    `${pathKey} input`,
    warnings,
  )
  if (inputResolved) {
    const bundled = bundleSchema(
      inputResolved.root,
      components,
      inputResolved.rootName,
      `${pathKey} input`,
    )
    input = bundled.schema
    warnings.push(...bundled.warnings)
  }

  let outputContent: MediaContent | undefined
  if (strategy === 'sibling-get') {
    const sibling = spec.paths?.[`${pathKey}/requests/{request_id}`]?.get as
      | OperationShape
      | undefined
    outputContent = sibling?.responses?.['200']?.content?.['application/json']
  } else {
    for (const status of ['200', '201', '202']) {
      outputContent = post.responses?.[status]?.content?.['application/json']
      if (outputContent?.schema !== undefined) break
    }
  }

  let output: Record<string, JsonValue> | undefined
  const outputResolved = resolveContentSchema(
    outputContent,
    components,
    `${pathKey} output`,
    warnings,
  )
  if (outputResolved) {
    const bundled = bundleSchema(
      outputResolved.root,
      components,
      outputResolved.rootName,
      `${pathKey} output`,
    )
    output = bundled.schema
    warnings.push(...bundled.warnings)
  }

  return { input, output, warnings }
}

/** Endpoint id convention from the PR: the path minus its leading slash. */
export function endpointIdFromPath(pathKey: string): string {
  return pathKey.replace(/^\//, '')
}

/**
 * Verify a bundled schema is self-contained: every `$ref` is either `#` or
 * `#/$defs/<name>` with `<name>` present in the top-level `$defs`. Returns
 * the list of violations (empty = self-contained). Exported for tests and
 * sync-time sanity checks.
 */
export function findDanglingRefs(
  schema: Record<string, JsonValue>,
): Array<string> {
  const defs = isObject(schema.$defs) ? schema.$defs : {}
  const violations: Array<string> = []
  const walk = (node: JsonValue): void => {
    if (typeof node !== 'object' || node === null) return
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') {
        if (value === '#') continue
        if (value.startsWith(DEFS_REF_PREFIX)) {
          const name = value.slice(DEFS_REF_PREFIX.length)
          if (!(name in defs)) violations.push(value)
          continue
        }
        violations.push(value)
      } else {
        walk(value)
      }
    }
  }
  walk(schema)
  return violations
}
