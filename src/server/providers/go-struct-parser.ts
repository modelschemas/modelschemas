/**
 * Go source → JSON Schema.
 *
 * BytePlus ships no fetchable OpenAPI document, but its official Go SDK
 * (`byteplus-sdk/byteplus-go-sdk-v2`) declares the whole Ark data plane as
 * plain structs with `json:"…"` tags. Unlike the Python SDK — whose Pydantic
 * models need a Python runtime to introspect — Go structs are just text, so
 * this parser runs inside the Worker on the ordinary spec-sync cron and the
 * spec tracks upstream SDK releases with no codegen step.
 *
 * Deliberately narrow: it understands the subset of Go the SDK's model
 * package actually uses (see `go-struct-parser.test.ts` for the census it was
 * written against), not the language. Anything it cannot map becomes an
 * unconstrained schema plus a warning rather than a hard failure — a partial
 * spec still beats no spec, and the warnings surface in the sync outcome.
 */

export type JsonSchema = Record<string, unknown>

export interface ParsedGoSource {
  /** Component schemas keyed by Go type name. */
  schemas: Record<string, JsonSchema>
  warnings: Array<string>
}

export interface GoSourceFile {
  /** Display name used in warnings (e.g. `chat_completion.go`). */
  name: string
  text: string
}

/** Go primitive → JSON Schema type. */
const GO_PRIMITIVES: Record<string, JsonSchema> = {
  string: { type: 'string' },
  bool: { type: 'boolean' },
  int: { type: 'integer' },
  int8: { type: 'integer' },
  int16: { type: 'integer' },
  int32: { type: 'integer' },
  int64: { type: 'integer' },
  uint: { type: 'integer' },
  uint8: { type: 'integer' },
  uint16: { type: 'integer' },
  uint32: { type: 'integer' },
  uint64: { type: 'integer' },
  float32: { type: 'number' },
  float64: { type: 'number' },
  // Go aliases: byte = uint8, rune = int32.
  byte: { type: 'integer' },
  rune: { type: 'integer' },
  'time.Time': { type: 'string', format: 'date-time' },
  'json.RawMessage': {},
  any: {},
  'interface{}': {},
}

interface GoField {
  /** JSON wire name. */
  name: string
  goType: string
  description?: string
  /** Go's `omitempty` is the SDK's own optionality signal. */
  optional: boolean
}

interface GoStruct {
  name: string
  description?: string
  fields: Array<GoField>
}

/** `// comment` lines immediately above a declaration become its description. */
function collectDocComment(lines: Array<string>, declIndex: number): string {
  const out: Array<string> = []
  for (let i = declIndex - 1; i >= 0; i--) {
    const line = lines[i]?.trim() ?? ''
    if (line.startsWith('//')) {
      out.unshift(line.replace(/^\/\/\s?/, ''))
      continue
    }
    break
  }
  return out.join(' ').trim()
}

/**
 * Split a struct-field line into (name, type, tag).
 *
 * Go field syntax is `Name Type \`tag\``, with the name omitted for an
 * embedded type. Types never contain spaces in this package
 * (`map[string]interface{}`, `[]*ChatCompletionMessage`), so once the
 * backtick tag is removed a whitespace split is unambiguous.
 */
function parseFieldLine(
  raw: string,
): { ident?: string; goType: string; tag?: string } | null {
  const line = raw.trim()
  if (!line || line.startsWith('//')) return null

  const tagMatch = /`([^`]*)`\s*$/.exec(line)
  const tag = tagMatch?.[1]
  const head = (tagMatch ? line.slice(0, tagMatch.index) : line).trim()
  if (!head) return null

  const parts = head.split(/\s+/)
  // A lone token is an embedded type (`ExtraBody`, `HttpHeader`).
  if (parts.length === 1) return { goType: parts[0] ?? '', tag }
  return { ident: parts[0], goType: parts.slice(1).join(' '), tag }
}

/** Pull the wire name and `omitempty` out of a struct tag. */
function parseJsonTag(
  tag: string | undefined,
): { name: string; optional: boolean } | null {
  if (!tag) return null
  const raw = /json:"([^"]*)"/.exec(tag)?.[1]
  if (raw === undefined) return null
  const [name = '', ...opts] = raw.split(',')
  // `json:"-"` means "never serialise".
  if (name === '-') return null
  return { name, optional: opts.includes('omitempty') }
}

interface Declarations {
  structs: Map<string, GoStruct>
  /** `type X string` → enum values gathered from const blocks. */
  namedScalars: Map<string, { underlying: string; description?: string }>
  /** `type X = Y`. */
  aliases: Map<string, string>
  /** `type X map[K]V` / `type X []T`. */
  namedComposites: Map<string, string>
  enums: Map<string, Array<string>>
}

function parseDeclarations(files: Array<GoSourceFile>): {
  decls: Declarations
  warnings: Array<string>
} {
  const decls: Declarations = {
    structs: new Map(),
    namedScalars: new Map(),
    aliases: new Map(),
    namedComposites: new Map(),
    enums: new Map(),
  }
  const warnings: Array<string> = []

  for (const file of files) {
    const lines = file.text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? ''

      // ---- struct ----
      const structMatch = /^type\s+(\w+)\s+struct\s*\{/.exec(line)
      if (structMatch) {
        const name = structMatch[1] ?? ''
        const fields: Array<GoField> = []
        let j = i + 1
        for (; j < lines.length; j++) {
          const body = lines[j] ?? ''
          if (/^\}/.test(body)) break
          const parsed = parseFieldLine(body)
          if (!parsed) continue
          const json = parseJsonTag(parsed.tag)
          if (!json) continue
          // An embedded type with a wire name behaves like a normal field.
          fields.push({
            name: json.name,
            goType: parsed.goType,
            optional: json.optional,
            description: collectDocComment(lines, j) || undefined,
          })
        }
        decls.structs.set(name, {
          name,
          description: collectDocComment(lines, i) || undefined,
          fields,
        })
        i = j
        continue
      }

      // ---- alias: type X = Y ----
      const aliasMatch = /^type\s+(\w+)\s*=\s*([\w.]+)\s*$/.exec(line)
      if (aliasMatch) {
        decls.aliases.set(aliasMatch[1] ?? '', aliasMatch[2] ?? '')
        continue
      }

      // ---- named composite: type X map[...]... / []T ----
      const compositeMatch = /^type\s+(\w+)\s+((?:map\[|\[\]).+)$/.exec(line)
      if (compositeMatch) {
        decls.namedComposites.set(
          compositeMatch[1] ?? '',
          (compositeMatch[2] ?? '').trim(),
        )
        continue
      }

      // ---- named scalar: type X string ----
      const scalarMatch = /^type\s+(\w+)\s+([\w.]+)\s*$/.exec(line)
      const scalarUnderlying = scalarMatch?.[2]
      if (scalarMatch && scalarUnderlying && GO_PRIMITIVES[scalarUnderlying]) {
        decls.namedScalars.set(scalarMatch[1] ?? '', {
          underlying: scalarUnderlying,
          description: collectDocComment(lines, i) || undefined,
        })
        continue
      }

      // ---- const block: enum values for named scalars ----
      if (/^const\s*\(/.test(line)) {
        for (let j = i + 1; j < lines.length; j++) {
          const body = lines[j] ?? ''
          if (/^\)/.test(body)) {
            i = j
            break
          }
          // `ThinkingTypeEnabled  ThinkingType = "enabled"`
          const entry = /^\s*\w+\s+(\w+)\s*=\s*"([^"]*)"/.exec(body)
          if (!entry) continue
          const typeName = entry[1] ?? ''
          const value = entry[2] ?? ''
          const existing = decls.enums.get(typeName) ?? []
          if (!existing.includes(value)) existing.push(value)
          decls.enums.set(typeName, existing)
        }
        continue
      }

      // Single-line const: `const X Type = "v"`
      const singleConst = /^const\s+\w+\s+(\w+)\s*=\s*"([^"]*)"/.exec(line)
      if (singleConst) {
        const typeName = singleConst[1] ?? ''
        const value = singleConst[2] ?? ''
        const existing = decls.enums.get(typeName) ?? []
        if (!existing.includes(value)) existing.push(value)
        decls.enums.set(typeName, existing)
      }
    }
  }

  if (decls.structs.size === 0) {
    warnings.push('go-parser: no struct declarations found')
  }
  return { decls, warnings }
}

const REF_PREFIX = '#/components/schemas/'

/** Resolve a Go type expression to a JSON Schema, recording refs it needs. */
function typeToSchema(
  goType: string,
  decls: Declarations,
  used: Set<string>,
  warnings: Array<string>,
  context: string,
): JsonSchema {
  let type = goType.trim()
  // Pointers carry no JSON meaning — optionality comes from `omitempty`.
  while (type.startsWith('*')) type = type.slice(1)

  if (type.startsWith('[]')) {
    const inner = type.slice(2)
    // []byte marshals to a base64 string, not an array.
    if (inner === 'byte' || inner === 'uint8') return { type: 'string' }
    return {
      type: 'array',
      items: typeToSchema(inner, decls, used, warnings, context),
    }
  }

  const mapMatch = /^map\[[^\]]+\](.+)$/.exec(type)
  if (mapMatch) {
    const value = typeToSchema(
      mapMatch[1] ?? '',
      decls,
      used,
      warnings,
      context,
    )
    return {
      type: 'object',
      ...(Object.keys(value).length > 0 ? { additionalProperties: value } : {}),
    }
  }

  const primitive = GO_PRIMITIVES[type]
  if (primitive) return { ...primitive }

  const alias = decls.aliases.get(type)
  if (alias) return typeToSchema(alias, decls, used, warnings, context)

  const composite = decls.namedComposites.get(type)
  if (composite) return typeToSchema(composite, decls, used, warnings, context)

  if (decls.structs.has(type) || decls.namedScalars.has(type)) {
    used.add(type)
    return { $ref: REF_PREFIX + type }
  }

  // Qualified types from packages we did not fetch, and anything else the
  // subset does not model: unconstrained rather than wrong.
  warnings.push(`go-parser: ${context}: unmapped type '${goType}'`)
  return {}
}

function structToSchema(
  struct: GoStruct,
  decls: Declarations,
  used: Set<string>,
  warnings: Array<string>,
): JsonSchema {
  const properties: Record<string, JsonSchema> = {}
  const required: Array<string> = []
  for (const field of struct.fields) {
    const schema = typeToSchema(
      field.goType,
      decls,
      used,
      warnings,
      `${struct.name}.${field.name}`,
    )
    properties[field.name] = field.description
      ? { ...schema, description: field.description }
      : schema
    // No `omitempty` means Go always writes the field.
    if (!field.optional) required.push(field.name)
  }
  return {
    type: 'object',
    ...(struct.description ? { description: struct.description } : {}),
    properties,
    ...(required.length > 0 ? { required } : {}),
  }
}

function namedScalarToSchema(name: string, decls: Declarations): JsonSchema {
  const scalar = decls.namedScalars.get(name)
  const base = { ...(GO_PRIMITIVES[scalar?.underlying ?? 'string'] ?? {}) }
  const values = decls.enums.get(name)
  return {
    ...base,
    ...(scalar?.description ? { description: scalar.description } : {}),
    ...(values?.length ? { enum: values } : {}),
  }
}

/**
 * Parse Go sources and emit component schemas for `roots` plus their full
 * reference closure — nothing else, so unrelated SDK types (batch jobs,
 * context caching, …) stay out of the document.
 */
export function parseGoSchemas(
  files: Array<GoSourceFile>,
  roots: Array<string>,
): ParsedGoSource {
  const { decls, warnings } = parseDeclarations(files)
  const schemas: Record<string, JsonSchema> = {}

  const queue = [...roots]
  const seen = new Set<string>()
  while (queue.length > 0) {
    const name = queue.shift()
    if (name === undefined || seen.has(name)) continue
    seen.add(name)

    const used = new Set<string>()
    const struct = decls.structs.get(name)
    if (struct) {
      schemas[name] = structToSchema(struct, decls, used, warnings)
    } else if (decls.namedScalars.has(name)) {
      schemas[name] = namedScalarToSchema(name, decls)
    } else {
      warnings.push(`go-parser: root type '${name}' not found`)
      continue
    }
    for (const ref of used) if (!seen.has(ref)) queue.push(ref)
  }

  return { schemas, warnings }
}
