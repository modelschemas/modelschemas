/**
 * AsyncAPI 3.x message-schema extraction. Bundles client (send) and
 * server (receive) payloads as a `type`-discriminated `oneOf` via
 * {@link bundleSchema}. FAL WMA is the only caller today.
 */
import { bundleSchema, findDanglingRefs } from './bundle.ts'
import type { ExtractedEndpointSchemas, JsonValue } from './bundle.ts'

function isObject(node: unknown): node is Record<string, unknown> {
  return typeof node === 'object' && node !== null && !Array.isArray(node)
}

function isJsonValue(node: unknown): node is JsonValue {
  if (node === null) return true
  const t = typeof node
  if (t === 'string' || t === 'number' || t === 'boolean') return true
  if (Array.isArray(node)) return node.every(isJsonValue)
  if (isObject(node)) {
    return Object.values(node).every(isJsonValue)
  }
  return false
}

function jsonPointer(doc: unknown, ref: string): unknown {
  if (!ref.startsWith('#/')) return undefined
  const parts = ref
    .slice(2)
    .split('/')
    .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))
  let current: unknown = doc
  for (const part of parts) {
    if (Array.isArray(current)) {
      const index = Number(part)
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return undefined
      }
      current = current[index]
      continue
    }
    if (!isObject(current) || !(part in current)) return undefined
    current = current[part]
  }
  return current
}

/** Follow `$ref` until a concrete node (cycle-capped). */
function unwrap(doc: unknown, node: unknown, depth = 0): unknown {
  if (depth > 20) return node
  if (isObject(node) && typeof node.$ref === 'string') {
    const target = jsonPointer(doc, node.$ref)
    if (target === undefined) return node
    return unwrap(doc, target, depth + 1)
  }
  return node
}

function schemaComponents(doc: unknown): Record<string, JsonValue> {
  if (!isObject(doc)) return {}
  const components = doc.components
  if (!isObject(components) || !isObject(components.schemas)) return {}
  const out: Record<string, JsonValue> = {}
  for (const [name, schema] of Object.entries(components.schemas)) {
    if (isJsonValue(schema)) out[name] = schema
  }
  return out
}

function messagePayload(doc: unknown, messageNode: unknown): JsonValue | null {
  const message = unwrap(doc, messageNode)
  if (!isObject(message)) return null
  const payload = message.payload
  if (payload === undefined) return null
  if (!isJsonValue(payload)) return null
  return payload
}

function collectFromOperations(
  doc: unknown,
  action: 'send' | 'receive',
): Array<JsonValue> {
  if (!isObject(doc) || !isObject(doc.operations)) return []
  const payloads: Array<JsonValue> = []
  for (const op of Object.values(doc.operations)) {
    if (!isObject(op) || op.action !== action) continue
    if (!Array.isArray(op.messages)) continue
    for (const item of op.messages) {
      const payload = messagePayload(doc, item)
      if (payload !== null) payloads.push(payload)
    }
  }
  return payloads
}

function collectFromComponentMessages(
  doc: unknown,
  prefix: 'client.' | 'server.',
): Array<JsonValue> {
  if (!isObject(doc) || !isObject(doc.components)) return []
  const messages = doc.components.messages
  if (!isObject(messages)) return []
  const payloads: Array<JsonValue> = []
  for (const name of Object.keys(messages).sort()) {
    if (!name.startsWith(prefix)) continue
    const payload = messagePayload(doc, messages[name])
    if (payload !== null) payloads.push(payload)
  }
  return payloads
}

function payloadsFor(
  doc: unknown,
  action: 'send' | 'receive',
  fallbackPrefix: 'client.' | 'server.',
): Array<JsonValue> {
  const fromOps = collectFromOperations(doc, action)
  if (fromOps.length > 0) return fromOps
  const hasOperations =
    isObject(doc) &&
    isObject(doc.operations) &&
    Object.keys(doc.operations).length > 0
  if (hasOperations) return fromOps
  return collectFromComponentMessages(doc, fallbackPrefix)
}

function bundleOneOf(
  payloads: Array<JsonValue>,
  components: Record<string, JsonValue>,
  title: string,
  context: string,
): { schema?: Record<string, JsonValue>; warnings: Array<string> } {
  if (payloads.length === 0) return { warnings: [] }
  const bundled = bundleSchema(
    { title, oneOf: payloads },
    components,
    null,
    context,
  )
  const dangling = findDanglingRefs(bundled.schema)
  const warnings = [...bundled.warnings]
  if (dangling.length > 0) {
    warnings.push(`${context}: bundled schema has dangling refs`)
  }
  return { schema: bundled.schema, warnings }
}

function typeConstOf(schema: unknown): string {
  if (!isObject(schema) || !isObject(schema.properties)) return ''
  const type = schema.properties.type
  if (!isObject(type) || typeof type.const !== 'string') return ''
  return type.const
}

/** `type` consts on a bundled oneOf (follows `#/$defs/` refs). */
export function asyncApiMessageTypes(schema: unknown): Array<string> {
  if (!isObject(schema) || !Array.isArray(schema.oneOf)) return []
  const defs = isObject(schema.$defs) ? schema.$defs : {}
  return schema.oneOf.map((item) => {
    if (
      isObject(item) &&
      typeof item.$ref === 'string' &&
      item.$ref.startsWith('#/$defs/')
    ) {
      return typeConstOf(defs[item.$ref.slice('#/$defs/'.length)])
    }
    return typeConstOf(item)
  })
}

/**
 * Client-message payloads → `input` oneOf; server-message payloads →
 * `output` oneOf. Each variant keeps its `type` const from the document.
 */
export function extractAsyncApiSchemas(
  document: unknown,
): ExtractedEndpointSchemas {
  const warnings: Array<string> = []
  if (!isObject(document) || typeof document.asyncapi !== 'string') {
    return { warnings: ['asyncapi: document is missing an asyncapi version'] }
  }
  const components = schemaComponents(document)
  const input = bundleOneOf(
    payloadsFor(document, 'send', 'client.'),
    components,
    'Client messages',
    'asyncapi input',
  )
  const output = bundleOneOf(
    payloadsFor(document, 'receive', 'server.'),
    components,
    'Server messages',
    'asyncapi output',
  )
  warnings.push(...input.warnings, ...output.warnings)
  return { input: input.schema, output: output.schema, warnings }
}

export function hasAsyncApiFlag(capabilities: unknown): boolean {
  return isObject(capabilities) && capabilities.asyncapi === true
}

/** Add or drop `asyncapi: true` on a capabilities object; keep other keys. */
export function withAsyncApiFlag(
  capabilities: unknown,
  enabled: boolean,
): unknown {
  if (!enabled) {
    if (!isObject(capabilities) || capabilities.asyncapi === undefined) {
      return capabilities
    }
    const next: Record<string, unknown> = { ...capabilities }
    delete next.asyncapi
    return next
  }
  const base = isObject(capabilities) ? { ...capabilities } : {}
  base.asyncapi = true
  return base
}

/**
 * Poll listings omit the AsyncAPI flag (they do not re-probe). Keep a
 * previously persisted `asyncapi: true` unless the listing sets the key.
 */
export function preserveAsyncApiFlag(
  existing: unknown,
  listed: unknown,
): unknown {
  if (!hasAsyncApiFlag(existing)) return listed
  if (isObject(listed) && listed.asyncapi === undefined) {
    return withAsyncApiFlag(listed, true)
  }
  return listed
}
