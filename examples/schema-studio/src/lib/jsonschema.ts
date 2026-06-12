/**
 * Type-safe helpers for walking arbitrary JSON Schema documents. Every
 * accessor narrows from `unknown` so the strict no-unsafe-* lint rules hold
 * even though schemas arrive as plain JSON.
 */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | Array<JsonValue>
  | { [key: string]: JsonValue }

export type JsonObject = { [key: string]: JsonValue }

export type SchemaNode = { readonly [key: string]: unknown }

export function isSchemaNode(value: unknown): value is SchemaNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isJsonObject(
  value: JsonValue | undefined,
): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function str(node: SchemaNode, key: string): string | undefined {
  const value = node[key]
  return typeof value === 'string' ? value : undefined
}

export function num(node: SchemaNode, key: string): number | undefined {
  const value = node[key]
  return typeof value === 'number' ? value : undefined
}

export function bool(node: SchemaNode, key: string): boolean | undefined {
  const value = node[key]
  return typeof value === 'boolean' ? value : undefined
}

export function arr(node: SchemaNode, key: string): Array<unknown> | undefined {
  const value = node[key]
  return Array.isArray(value) ? value : undefined
}

export function obj(node: SchemaNode, key: string): SchemaNode | undefined {
  const value = node[key]
  return isSchemaNode(value) ? value : undefined
}

/** Property map of an object schema, with non-object entries dropped. */
export function properties(node: SchemaNode): Array<[string, SchemaNode]> {
  const props = obj(node, 'properties')
  if (props === undefined) return []
  const out: Array<[string, SchemaNode]> = []
  for (const [key, value] of Object.entries(props)) {
    if (isSchemaNode(value)) out.push([key, value])
  }
  return out
}

export function requiredNames(node: SchemaNode): Set<string> {
  const names = new Set<string>()
  for (const entry of arr(node, 'required') ?? []) {
    if (typeof entry === 'string') names.add(entry)
  }
  return names
}

/** `type` keyword, taking the first entry when it is an array. */
export function schemaType(node: SchemaNode): string | undefined {
  const single = str(node, 'type')
  if (single !== undefined) return single
  const many = arr(node, 'type')
  const first = many?.find((t): t is string => typeof t === 'string')
  return first
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true
  const kind = typeof value
  if (kind === 'string' || kind === 'number' || kind === 'boolean') return true
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (kind === 'object')
    return Object.values(value as object).every(isJsonValue)
  return false
}

export function asJsonValue(value: unknown): JsonValue | undefined {
  return isJsonValue(value) ? value : undefined
}

export function enumValues(node: SchemaNode): Array<JsonValue> | undefined {
  const values = arr(node, 'enum')
  if (values === undefined) return undefined
  const out: Array<JsonValue> = []
  for (const value of values) {
    const json = asJsonValue(value)
    if (json !== undefined) out.push(json)
  }
  return out.length > 0 ? out : undefined
}

/** Follow `$ref: "#/$defs/Name"` chains against the root schema's `$defs`. */
export function resolveRef(node: SchemaNode, root: SchemaNode): SchemaNode {
  let current = node
  for (let hop = 0; hop < 16; hop++) {
    const ref = str(current, '$ref')
    if (ref === undefined || !ref.startsWith('#/$defs/')) return current
    const defs = obj(root, '$defs')
    const target =
      defs === undefined ? undefined : defs[ref.slice('#/$defs/'.length)]
    if (!isSchemaNode(target)) return current
    current = target
  }
  return current
}

/** anyOf/oneOf variants (resolved against root), or undefined. */
export function variants(
  node: SchemaNode,
  root: SchemaNode,
): Array<SchemaNode> | undefined {
  const list = arr(node, 'anyOf') ?? arr(node, 'oneOf')
  if (list === undefined) return undefined
  const out = list.filter(isSchemaNode).map((v) => resolveRef(v, root))
  return out.length > 0 ? out : undefined
}

/** A short human label for a schema, for variant tabs and array items. */
export function schemaLabel(node: SchemaNode, fallback: string): string {
  const title = str(node, 'title')
  if (title !== undefined) return title
  const constant = node['const']
  if (typeof constant === 'string') return constant
  const type = schemaType(node)
  if (type === 'object') {
    const props = properties(node)
    const typeProp = props.find(([name]) => name === 'type')?.[1]
    const tag = typeProp === undefined ? undefined : enumValues(typeProp)?.[0]
    if (typeof tag === 'string') return tag
  }
  if (type !== undefined) return type
  if (enumValues(node) !== undefined) return 'enum'
  return fallback
}

/** Build a starter value for a schema: default → example → const → enum[0]
 * → type seed. Objects seed required properties only. */
export function seedValue(
  node: SchemaNode,
  root: SchemaNode,
  depth = 0,
): JsonValue {
  if (depth > 12) return null
  const resolved = resolveRef(node, root)
  for (const key of ['default', 'const', 'example'] as const) {
    const candidate = asJsonValue(resolved[key])
    if (candidate !== undefined) return candidate
  }
  const options = enumValues(resolved)
  if (options !== undefined && options[0] !== undefined) return options[0]
  const variantList = variants(resolved, root)
  if (variantList?.[0] !== undefined)
    return seedValue(variantList[0], root, depth + 1)
  switch (schemaType(resolved)) {
    case 'string':
      return ''
    case 'integer':
    case 'number':
      return num(resolved, 'minimum') ?? 0
    case 'boolean':
      return false
    case 'array': {
      const minItems = num(resolved, 'minItems') ?? 0
      const items = obj(resolved, 'items')
      if (minItems > 0 && items !== undefined)
        return Array.from({ length: minItems }, () =>
          seedValue(items, root, depth + 1),
        )
      return []
    }
    case 'object': {
      const out: JsonObject = {}
      const required = requiredNames(resolved)
      for (const [name, prop] of properties(resolved)) {
        if (required.has(name))
          out[name] = seedValue(resolveRef(prop, root), root, depth + 1)
      }
      return out
    }
    case 'null':
      return null
    default:
      return null
  }
}

/** Index of the variant whose shape best matches the current value. */
export function matchVariant(
  value: JsonValue | undefined,
  variantList: Array<SchemaNode>,
): number {
  if (value === undefined) return 0
  let best = 0
  let bestScore = -1
  variantList.forEach((variant, index) => {
    let score = 0
    const type = schemaType(variant)
    const valueType = Array.isArray(value) ? 'array' : typeof value
    if (type === valueType) score += 1
    if (type === 'integer' && valueType === 'number') score += 1
    const options = enumValues(variant)
    if (options?.some((option) => option === value) === true) score += 2
    if (isJsonObject(value) && type === 'object') {
      const props = properties(variant)
      for (const [name, prop] of props) {
        if (name in value) {
          score += 1
          const tag = enumValues(prop)?.[0]
          if (tag !== undefined && value[name] === tag) score += 3
        }
      }
    }
    if (score > bestScore) {
      bestScore = score
      best = index
    }
  })
  return best
}
