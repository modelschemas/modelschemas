/**
 * JSON Schema → property-table rows for the human-readable schema view.
 * Pure and defensive: provider schemas vary wildly (hand-written OpenAPI,
 * pydantic output, FAL's generated specs), so every accessor tolerates
 * missing or oddly-typed fields and falls back to a generic label.
 */

export type TypeClass =
  | 'string'
  | 'number'
  | 'boolean'
  | 'enum'
  | 'object'
  | 'array'
  | 'union'

export interface PropRow {
  name: string
  required: boolean
  typeLabel: string
  typeClass: TypeClass
  constraints: Array<string>
  deprecated: boolean
  description: string | null
  children: Array<PropRow>
}

type SchemaNode = Record<string, unknown>

const MAX_DEPTH = 4
const MAX_ENUM_SHOWN = 6
const MAX_DESCRIPTION = 260

function isObject(value: unknown): value is SchemaNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function refName(ref: string): string {
  const last = ref.split('/').at(-1)
  return last && last.length > 0 ? last : ref
}

function resolveRef(node: SchemaNode, defs: SchemaNode): SchemaNode {
  const ref = node.$ref
  if (typeof ref !== 'string') return node
  const target = defs[refName(ref)]
  return isObject(target) ? target : node
}

function firstParagraph(text: string): string {
  const para = (text.split('\n\n')[0] ?? text).replaceAll(/\s+/g, ' ').trim()
  return para.length > MAX_DESCRIPTION
    ? `${para.slice(0, MAX_DESCRIPTION)}…`
    : para
}

function formatValue(value: unknown): string {
  // callers guard against undefined, so stringify always yields a string
  const text = JSON.stringify(value)
  return text.length > 32 ? `${text.slice(0, 32)}…` : text
}

/** Union members minus `{type:"null"}` / `null` markers. */
function nonNullVariants(variants: Array<unknown>): Array<SchemaNode> {
  return variants.filter(
    (v): v is SchemaNode => isObject(v) && v.type !== 'null',
  )
}

/** Short label for use inside union/array labels. */
function shortLabel(node: SchemaNode, defs: SchemaNode): string {
  if (typeof node.$ref === 'string') return refName(node.$ref)
  if (Array.isArray(node.enum)) return 'enum'
  if (node.const !== undefined) return formatValue(node.const)
  const variants = node.anyOf ?? node.oneOf
  if (Array.isArray(variants)) {
    const real = nonNullVariants(variants)
    const single = real.length === 1 ? real[0] : undefined
    if (single !== undefined) return shortLabel(single, defs)
    return real
      .slice(0, 3)
      .map((v) => shortLabel(v, defs))
      .join(' | ')
  }
  if (node.type === 'array') {
    const items = isObject(node.items) ? node.items : {}
    return `${shortLabel(items, defs)}[]`
  }
  if (typeof node.type === 'string') {
    if (node.type === 'object' && typeof node.title === 'string') {
      return node.title
    }
    return node.type
  }
  if (typeof node.title === 'string') return node.title
  return 'any'
}

function numericConstraints(node: SchemaNode): Array<string> {
  const out: Array<string> = []
  const min = node.minimum ?? node.exclusiveMinimum
  const max = node.maximum ?? node.exclusiveMaximum
  const minOp = node.minimum !== undefined ? '≤' : '<'
  const maxOp = node.maximum !== undefined ? '≤' : '<'
  if (typeof min === 'number' && typeof max === 'number') {
    out.push(`${String(min)} ${minOp} n ${maxOp} ${String(max)}`)
  } else if (typeof min === 'number') {
    out.push(
      node.minimum !== undefined ? `n ≥ ${String(min)}` : `n > ${String(min)}`,
    )
  } else if (typeof max === 'number') {
    out.push(
      node.maximum !== undefined ? `n ≤ ${String(max)}` : `n < ${String(max)}`,
    )
  }
  if (typeof node.minLength === 'number') {
    out.push(`length ≥ ${String(node.minLength)}`)
  }
  if (typeof node.maxLength === 'number') {
    out.push(`length ≤ ${String(node.maxLength)}`)
  }
  if (typeof node.minItems === 'number') {
    out.push(`items ≥ ${String(node.minItems)}`)
  }
  if (typeof node.maxItems === 'number') {
    out.push(`items ≤ ${String(node.maxItems)}`)
  }
  return out
}

function enumConstraint(values: Array<unknown>): string {
  const shown = values.slice(0, MAX_ENUM_SHOWN).map(formatValue)
  const extra = values.length - MAX_ENUM_SHOWN
  const list = shown.join(' | ').replaceAll('"', '')
  return extra > 0 ? `${list} · +${String(extra)} more` : list
}

function childRows(
  node: SchemaNode,
  defs: SchemaNode,
  depth: number,
  seen: Set<string>,
): Array<PropRow> {
  if (depth >= MAX_DEPTH) return []
  const properties = node.properties
  if (!isObject(properties)) return []
  const required = Array.isArray(node.required)
    ? node.required.filter((r): r is string => typeof r === 'string')
    : []
  return propertyRows(properties, required, defs, depth, seen)
}

function buildRow(
  name: string,
  rawNode: unknown,
  required: boolean,
  defs: SchemaNode,
  depth: number,
  seen: Set<string>,
): PropRow {
  const node = isObject(rawNode) ? rawNode : {}
  const ref = typeof node.$ref === 'string' ? refName(node.$ref) : null
  const cycle = ref !== null && seen.has(ref)
  const nextSeen = ref === null ? seen : new Set([...seen, ref])
  const resolved = cycle ? node : resolveRef(node, defs)

  // annotations on the reference site win over the referenced definition
  const description =
    typeof node.description === 'string'
      ? node.description
      : typeof resolved.description === 'string'
        ? resolved.description
        : null
  const deprecated = node.deprecated === true || resolved.deprecated === true

  const constraints: Array<string> = []
  let typeLabel = 'any'
  let typeClass: TypeClass = 'union'
  let children: Array<PropRow> = []

  const variantsRaw = resolved.anyOf ?? resolved.oneOf ?? resolved.allOf
  const enumValues = resolved.enum

  if (Array.isArray(enumValues)) {
    typeLabel = 'enum'
    typeClass = 'enum'
    constraints.push(enumConstraint(enumValues))
  } else if (resolved.const !== undefined) {
    typeLabel = 'const'
    typeClass = 'enum'
    constraints.push(formatValue(resolved.const))
  } else if (Array.isArray(variantsRaw) && !cycle) {
    const real = nonNullVariants(variantsRaw)
    const nullable = real.length < variantsRaw.length
    const single = real.length === 1 ? real[0] : undefined
    if (single !== undefined) {
      const inner = buildRow(name, single, required, defs, depth, nextSeen)
      if (nullable) inner.constraints.push('nullable')
      if (inner.description === null) inner.description = description
      inner.deprecated = inner.deprecated || deprecated
      return { ...inner, required }
    }
    // `string | const | const…` unions (model-id lists) read as string
    const allStringy = real.every((v) => {
      const r = resolveRef(v, defs)
      return r.type === 'string' || typeof r.const === 'string'
    })
    const consts = real.filter((v) => {
      const r = resolveRef(v, defs)
      return typeof r.const === 'string'
    })
    if (allStringy && consts.length > 0) {
      typeLabel = 'string'
      typeClass = 'string'
      constraints.push(`${String(consts.length)} known values`)
    } else {
      typeLabel = real
        .slice(0, 3)
        .map((v) => shortLabel(resolveRef(v, defs), defs))
        .join(' | ')
      if (real.length > 3) typeLabel += ' | …'
      if (typeLabel.length > 40) typeLabel = `${typeLabel.slice(0, 40)}…`
      typeClass = 'union'
    }
    if (nullable) constraints.push('nullable')
  } else if (resolved.type === 'array') {
    const items = isObject(resolved.items) ? resolved.items : {}
    const itemsResolved = resolveRef(items, defs)
    typeLabel = `${shortLabel(items, defs)}[]`
    typeClass = 'array'
    if (!cycle) children = childRows(itemsResolved, defs, depth + 1, nextSeen)
  } else if (resolved.type === 'object' || isObject(resolved.properties)) {
    typeLabel =
      ref ?? (typeof resolved.title === 'string' ? 'object' : 'object')
    typeClass = 'object'
    if (!cycle) children = childRows(resolved, defs, depth + 1, nextSeen)
  } else if (typeof resolved.type === 'string') {
    typeLabel = resolved.type
    typeClass =
      resolved.type === 'string'
        ? 'string'
        : resolved.type === 'number' || resolved.type === 'integer'
          ? 'number'
          : resolved.type === 'boolean'
            ? 'boolean'
            : 'union'
  } else if (ref !== null) {
    typeLabel = ref
    typeClass = 'object'
  }

  constraints.push(...numericConstraints(resolved))
  if (typeof resolved.format === 'string') {
    constraints.push(`format: ${resolved.format}`)
  }
  if (resolved.default !== undefined) {
    constraints.push(`default: ${formatValue(resolved.default)}`)
  }

  return {
    name,
    required,
    typeLabel,
    typeClass,
    constraints,
    deprecated,
    description: description === null ? null : firstParagraph(description),
    children,
  }
}

function propertyRows(
  properties: SchemaNode,
  required: Array<string>,
  defs: SchemaNode,
  depth: number,
  seen: Set<string>,
): Array<PropRow> {
  const requiredSet = new Set(required)
  return Object.entries(properties).map(([name, node]) =>
    buildRow(name, node, requiredSet.has(name), defs, depth, seen),
  )
}

export interface SchemaRows {
  /** Required properties first, in schema order; then optional. */
  rows: Array<PropRow>
  requiredCount: number
  propertyCount: number
  defsCount: number
  /** Set when the schema isn't an object with properties (rare). */
  fallback: boolean
}

/** Rows for a bundled endpoint schema (object root with `$defs` closure). */
export function schemaToRows(schema: unknown): SchemaRows {
  if (!isObject(schema) || !isObject(schema.properties)) {
    return {
      rows: [],
      requiredCount: 0,
      propertyCount: 0,
      defsCount: 0,
      fallback: true,
    }
  }
  const defs = isObject(schema.$defs) ? schema.$defs : {}
  const required = Array.isArray(schema.required)
    ? schema.required.filter((r): r is string => typeof r === 'string')
    : []
  const all = propertyRows(schema.properties, required, defs, 0, new Set())
  const rows = [
    ...all.filter((r) => r.required),
    ...all.filter((r) => !r.required),
  ]
  return {
    rows,
    requiredCount: required.length,
    propertyCount: all.length,
    defsCount: Object.keys(defs).length,
    fallback: false,
  }
}
