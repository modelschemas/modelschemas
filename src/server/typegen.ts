/**
 * Dependency-free JSON Schema → TypeScript emitter (PLAN.md task 12.1).
 * Produces the self-contained module served by `?format=types` and written
 * into user projects by the pull tooling: banner + exported `JsonSchema`
 * alias + schema const + named type declarations ($defs become exported
 * declarations, so circular refs are naturally legal).
 *
 * Output contract:
 * - Deterministic — no timestamps; ETags are contentHash + TYPEGEN_VERSION.
 * - tsconfig-agnostic — declaration-only types, zero imports, zero runtime
 *   side effects beyond the pure schema const; `unknown` wherever `any`
 *   would appear. The one flag-sensitive choice (optional properties under
 *   exactOptionalPropertyTypes) is the `optionalStyle` knob.
 * - Tree-shakeable — no barrel; every export is a pure const or a type.
 */

export const TYPEGEN_VERSION = 1

export type OptionalStyle = 'exact' | 'undefined'

export interface EmitInput {
  provider: string
  /** Public endpoint id, e.g. `v1/messages` or `chat/completions`. */
  endpointId: string
  kind: 'input' | 'output'
  contentHash: string
  schema: Record<string, unknown>
  optionalStyle?: OptionalStyle
  /** Canonical URL the schema was fetched from — printed in the banner. */
  sourceUrl?: string
}

type SchemaNode = Record<string, unknown>

interface EmitCtx {
  optionalStyle: OptionalStyle
  /** `$ref` string (e.g. `#/$defs/Tool`) → emitted type name. */
  refs: Map<string, string>
}

function isObject(value: unknown): value is SchemaNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/

function pascal(text: string): string {
  const name = text
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
  if (name === '') return 'Schema'
  return /^[0-9]/.test(name) ? `_${name}` : name
}

function lowerFirst(name: string): string {
  return name.charAt(0).toLowerCase() + name.slice(1)
}

/** JSDoc block from `description`/`deprecated`; empty string when neither. */
function jsdoc(node: SchemaNode, indent: string): string {
  const lines: Array<string> = []
  if (typeof node.description === 'string' && node.description.trim() !== '') {
    lines.push(...node.description.trim().split('\n'))
  }
  if (node.deprecated === true) lines.push('@deprecated')
  if (lines.length === 0) return ''
  const safe = lines.map((line) => line.replaceAll('*/', '*\\/'))
  if (safe.length === 1) return `${indent}/** ${safe[0]} */\n`
  const body = safe.map((line) => `${indent} * ${line}`.trimEnd()).join('\n')
  return `${indent}/**\n${body}\n${indent} */\n`
}

function literalType(value: unknown): string {
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value)
    case 'number':
    case 'boolean':
      return String(value)
    default:
      return value === null ? 'null' : 'unknown'
  }
}

function union(members: Array<string>): string {
  const unique = [...new Set(members)]
  return unique.length === 0 ? 'unknown' : unique.join(' | ')
}

/** Parenthesize compound expressions before joining into a larger one. */
function paren(expr: string): string {
  return expr.includes(' | ') || expr.includes(' & ') ? `(${expr})` : expr
}

function typeExpr(node: unknown, ctx: EmitCtx, indent: string): string {
  if (node === true || node === undefined) return 'unknown'
  if (node === false) return 'never'
  if (!isObject(node)) return 'unknown'

  if (typeof node.$ref === 'string') {
    return ctx.refs.get(node.$ref) ?? 'unknown'
  }

  let expr = coreExpr(node, ctx, indent)
  // OpenAPI 3.0-style nullability.
  if (node.nullable === true && expr !== 'null') {
    expr = union([expr, 'null'])
  }
  return expr
}

function coreExpr(node: SchemaNode, ctx: EmitCtx, indent: string): string {
  if (Array.isArray(node.enum) && node.enum.length > 0) {
    return union(node.enum.map(literalType))
  }
  if ('const' in node) return literalType(node.const)

  const parts: Array<string> = []
  if (Array.isArray(node.allOf) && node.allOf.length > 0) {
    parts.push(
      ...node.allOf.map((branch) => paren(typeExpr(branch, ctx, indent))),
    )
  }
  const variants = Array.isArray(node.anyOf)
    ? node.anyOf
    : Array.isArray(node.oneOf)
      ? node.oneOf
      : null
  if (variants !== null && variants.length > 0) {
    parts.push(
      paren(union(variants.map((branch) => typeExpr(branch, ctx, indent)))),
    )
  }
  const own = ownExpr(node, ctx, indent)
  if (own !== null) parts.push(parts.length > 0 ? paren(own) : own)

  const [first] = parts
  if (first === undefined) return 'unknown'
  return parts.length === 1 && first.startsWith('(')
    ? first.slice(1, -1)
    : parts.join(' & ')
}

/** The schema's own shape from `type`/`properties`/`items`; null if none. */
function ownExpr(
  node: SchemaNode,
  ctx: EmitCtx,
  indent: string,
): string | null {
  const type = node.type
  if (Array.isArray(type)) {
    return union(
      type.map((member) => typeForName(node, String(member), ctx, indent)),
    )
  }
  if (typeof type === 'string') return typeForName(node, type, ctx, indent)
  if (isObject(node.properties) || 'additionalProperties' in node) {
    return objectExpr(node, ctx, indent)
  }
  if ('items' in node || 'prefixItems' in node) {
    return arrayExpr(node, ctx, indent)
  }
  return null
}

function typeForName(
  node: SchemaNode,
  type: string,
  ctx: EmitCtx,
  indent: string,
): string {
  switch (type) {
    case 'string':
      return 'string'
    case 'number':
    case 'integer':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'null':
      return 'null'
    case 'array':
      return arrayExpr(node, ctx, indent)
    case 'object':
      return objectExpr(node, ctx, indent)
    default:
      return 'unknown'
  }
}

function arrayExpr(node: SchemaNode, ctx: EmitCtx, indent: string): string {
  const prefix = Array.isArray(node.prefixItems)
    ? node.prefixItems
    : Array.isArray(node.items)
      ? node.items
      : null
  if (prefix !== null) {
    const members = prefix.map((item) => typeExpr(item, ctx, indent))
    const restSchema = Array.isArray(node.items)
      ? node.additionalItems
      : node.items
    const closed = restSchema === false
    const rest = closed
      ? ''
      : `, ...Array<${typeExpr(restSchema === true ? undefined : restSchema, ctx, indent)}>`
    return `[${members.join(', ')}${rest}]`
  }
  return `Array<${typeExpr(node.items, ctx, indent)}>`
}

function objectExpr(node: SchemaNode, ctx: EmitCtx, indent: string): string {
  const props = isObject(node.properties) ? node.properties : {}
  const required = new Set(
    Array.isArray(node.required)
      ? node.required.filter((name) => typeof name === 'string')
      : [],
  )
  const keys = Object.keys(props)
  const additional = node.additionalProperties

  if (keys.length === 0) {
    if (isObject(additional)) {
      return `Record<string, ${typeExpr(additional, ctx, indent)}>`
    }
    if (additional === false) return 'Record<string, never>'
    return 'Record<string, unknown>'
  }

  const inner = `${indent}  `
  const members: Array<string> = []
  for (const key of keys) {
    const propSchema = props[key]
    const docs = isObject(propSchema) ? jsdoc(propSchema, inner) : ''
    const name = IDENT_RE.test(key) ? key : JSON.stringify(key)
    const optional = !required.has(key)
    let expr = typeExpr(propSchema, ctx, inner)
    if (optional && ctx.optionalStyle === 'undefined') {
      expr = union([expr, 'undefined'])
    }
    members.push(`${docs}${inner}${name}${optional ? '?' : ''}: ${expr}`)
  }
  // A named-property type can't carry a sound typed index signature, so an
  // open object degrades to an unknown-valued one.
  if (additional === true || isObject(additional)) {
    members.push(`${inner}[key: string]: unknown`)
  }
  return `{\n${members.join('\n')}\n${indent}}`
}

/** Interface when the schema is a plain object with named properties (nicer
 * hovers/extends); type alias for everything else. */
function declaration(name: string, node: unknown, ctx: EmitCtx): string {
  if (isObject(node)) {
    const docs = jsdoc(node, '')
    const isPlainObject =
      !('$ref' in node) &&
      !('enum' in node) &&
      !('const' in node) &&
      !('anyOf' in node) &&
      !('oneOf' in node) &&
      !('allOf' in node) &&
      node.nullable !== true &&
      (node.type === 'object' || node.type === undefined) &&
      isObject(node.properties) &&
      Object.keys(node.properties).length > 0
    if (isPlainObject) {
      return `${docs}export interface ${name} ${objectExpr(node, ctx, '')}\n`
    }
    return `${docs}export type ${name} = ${typeExpr(node, ctx, '')}\n`
  }
  return `export type ${name} = ${typeExpr(node, ctx, '')}\n`
}

export interface EmittedNames {
  /** e.g. `anthropicV1MessagesRequestSchema` */
  schemaConst: string
  /** e.g. `AnthropicV1MessagesRequest` */
  rootType: string
}

export function moduleNames(
  provider: string,
  endpointId: string,
  kind: 'input' | 'output',
): EmittedNames {
  const kindLabel = kind === 'input' ? 'Request' : 'Response'
  const rootType = pascal(provider) + pascal(endpointId) + kindLabel
  return { rootType, schemaConst: `${lowerFirst(rootType)}Schema` }
}

/** ETag for a types response: schema identity × emitter version × the one
 * output-shaping knob. Emission is deterministic, so this fully keys the
 * body. */
export function typesEtag(
  contentHash: string,
  optionalStyle: OptionalStyle,
): string {
  return `${contentHash}-types-v${TYPEGEN_VERSION}-${optionalStyle}`
}

/** Emit the full module text for one endpoint+kind schema. */
export function emitTypesModule(input: EmitInput): string {
  const optionalStyle = input.optionalStyle ?? 'exact'
  const { rootType, schemaConst } = moduleNames(
    input.provider,
    input.endpointId,
    input.kind,
  )

  const taken = new Set(['JsonSchema', rootType, schemaConst])
  const refs = new Map<string, string>()
  const defs: Array<{ name: string; node: unknown }> = []
  for (const container of ['$defs', 'definitions'] as const) {
    const block = input.schema[container]
    if (!isObject(block)) continue
    for (const key of Object.keys(block)) {
      let name = pascal(key)
      for (let suffix = 2; taken.has(name); suffix++) {
        name = `${pascal(key)}${suffix}`
      }
      taken.add(name)
      refs.set(`#/${container}/${key}`, name)
      defs.push({ name, node: block[key] })
    }
  }

  const ctx: EmitCtx = { optionalStyle, refs }
  const banner = [
    `// @generated by modelschemas typegen v${TYPEGEN_VERSION} — do not edit; refresh with \`modelschemas update\`.`,
    `// provider: ${input.provider} · endpoint: ${input.endpointId} · kind: ${input.kind}`,
    ...(input.sourceUrl !== undefined ? [`// source: ${input.sourceUrl}`] : []),
    `// schema version: ${input.contentHash}`,
  ].join('\n')

  const sections = [
    banner,
    `export type JsonSchema = { readonly [key: string]: unknown }`,
    `export const ${schemaConst}: JsonSchema = ${JSON.stringify(input.schema, null, 2)}`,
    declaration(rootType, input.schema, ctx).trimEnd(),
    ...defs.map(({ name, node }) => declaration(name, node, ctx).trimEnd()),
  ]
  return `${sections.join('\n\n')}\n`
}
