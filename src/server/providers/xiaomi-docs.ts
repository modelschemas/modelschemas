/** Xiaomi's public MDX schema trees and tables, converted without model tables. */
import type { OpenApiDocument } from './types.ts'

type RecordValue = Record<string, unknown>
export const XIAOMI_DOCS = 'https://mimo.mi.com/static/docs/'
export const XIAOMI_MODELS = `${XIAOMI_DOCS}quick-start/summary/model.md`
export const XIAOMI_PRICING = `${XIAOMI_DOCS}price/pay-as-you-go.md`
export const XIAOMI_THINKING = `${XIAOMI_DOCS}quick-start/usage-guide/text-generation/deep-thinking.md`
export const XIAOMI_SCHEMA_URLS = [
  'api/chat/openai-api.md',
  'api/chat/responses.md',
  'api/chat/anthropic-api.md',
  'api/audio/Speech-Recognition.md',
  'api/audio/tts.md',
].map((path) => `${XIAOMI_DOCS}${path}`)

function fail(message: string): never {
  throw new Error(`xiaomi: ${message}`)
}
function record(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
export function plain(text: string): string {
  return text
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Expand actual table spans before assigning a model its neighboring cells. */
export function htmlTables(text: string): Array<Array<Array<string>>> {
  const tables: Array<Array<Array<string>>> = []
  for (const table of text.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/g)) {
    const rows: Array<Array<string>> = []
    const spans = new Map<number, { value: string; remaining: number }>()
    for (const row of (table[1] ?? '').matchAll(
      /<tr\b[^>]*>([\s\S]*?)<\/tr>/g,
    )) {
      const cells: Array<string> = []
      let column = 0
      const fill = () => {
        while (spans.has(column)) {
          const span = spans.get(column)
          if (!span) fail('missing table span')
          cells.push(span.value)
          span.remaining--
          if (span.remaining === 0) spans.delete(column)
          column++
        }
      }
      for (const cell of (row[1] ?? '').matchAll(
        /<t[dh]\b([^>]*)>([\s\S]*?)<\/t[dh]>/g,
      )) {
        fill()
        const attrs = cell[1] ?? ''
        if (/colspan/.test(attrs)) fail('unsupported table colspan')
        const rowspan = Number(/rowspan="(\d+)"/.exec(attrs)?.[1] ?? '1')
        if (!Number.isInteger(rowspan) || rowspan < 1)
          fail('invalid table rowspan')
        const value = cell[2] ?? ''
        cells.push(value)
        if (rowspan > 1) spans.set(column, { value, remaining: rowspan - 1 })
        column++
      }
      fill()
      if (cells.length) rows.push(cells)
    }
    if (spans.size) fail('table rowspan extends past table')
    if (rows.length) tables.push(rows)
  }
  if (!tables.length) fail('document contains no model tables')
  return tables
}

interface NativeNode {
  name: string
  type: Array<string>
  isBold: boolean
  required?: boolean
  description?: string
  children: Array<NativeNode>
}
function node(value: unknown): NativeNode {
  if (
    !record(value) ||
    typeof value.name !== 'string' ||
    !value.name ||
    typeof value.isBold !== 'boolean'
  )
    fail('invalid native schema node')
  const types = typeof value.type === 'string' ? [value.type] : value.type
  if (
    !Array.isArray(types) ||
    !types.length ||
    !types.every(
      (type): type is string =>
        typeof type === 'string' &&
        [
          'string',
          'object',
          'array',
          'integer',
          'number',
          'boolean',
          'null',
          'long',
        ].includes(type),
    )
  )
    fail(`unsupported native type for ${value.name}`)
  if (value.required !== undefined && typeof value.required !== 'boolean')
    fail(`invalid required flag for ${value.name}`)
  if (value.description !== undefined && typeof value.description !== 'string')
    fail(`invalid description for ${value.name}`)
  if (value.children !== undefined && !Array.isArray(value.children))
    fail(`invalid children for ${value.name}`)
  return {
    name: value.name,
    type: types.map((type) => (type === 'long' ? 'integer' : type)),
    isBold: value.isBold,
    ...(typeof value.required === 'boolean'
      ? { required: value.required }
      : {}),
    ...(typeof value.description === 'string'
      ? { description: value.description }
      : {}),
    children: (value.children as Array<unknown> | undefined)?.map(node) ?? [],
  }
}

/** Only a flat explicit options list becomes an enum; conditional prose stays prose. */
function options(description: string): Array<string> | null {
  const tail = description.split(/Available options:\s*/).at(-1)
  if (tail === description || !tail || /<ul|<blockquote/.test(tail)) return null
  const codes = [...tail.matchAll(/<code\b[^>]*>([^<]+)<\/code>/g)].map(
    (match) => match[1] ?? '',
  )
  const remainder = tail
    .replace(/<code\b[^>]*>[^<]+<\/code>/g, '')
    .replace(/<br\s*\/?\s*>/g, '')
    .trim()
  return codes.length && /^[\s,.;]*$/.test(remainder) ? codes : null
}
function objectSchema(children: Array<NativeNode>): RecordValue {
  if (children.some((child) => !child.isBold))
    fail('anonymous variants mixed with named object fields')
  const properties: RecordValue = {}
  const required: Array<string> = []
  for (const child of children) {
    if (child.name in properties)
      fail(`duplicate schema property ${child.name}`)
    properties[child.name] = schema(child)
    if (child.required) required.push(child.name)
  }
  return {
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
  }
}
function alternatives(children: Array<NativeNode>): RecordValue {
  const variants = children.map(schema)
  if (!variants.length) fail('empty schema alternatives')
  return variants.length === 1
    ? (variants[0] ?? fail('empty schema variant'))
    : { anyOf: variants }
}
function schema(value: NativeNode): RecordValue {
  let out: RecordValue = {
    type: value.type.length === 1 ? value.type[0] : value.type,
  }
  const children = value.children
  if (children.length) {
    if (children.every((child) => !child.isBold)) {
      // A same-type wrapper describes the value itself, not another array level.
      if (
        value.type.length > 1 ||
        children.every((child) => value.type.includes(child.type[0] ?? ''))
      ) {
        out = alternatives(children)
        if (
          value.type.includes('null') &&
          !children.some((child) => child.type.includes('null'))
        )
          out = { anyOf: [out, { type: 'null' }] }
      } else if (value.type.includes('array')) {
        out.items = alternatives(children)
      } else if (value.type.includes('object')) {
        out = alternatives(children)
      } else fail(`children do not describe ${value.name}`)
    } else if (children.every((child) => child.isBold)) {
      if (value.type.includes('array')) out.items = objectSchema(children)
      else if (value.type.includes('object'))
        out = {
          ...objectSchema(children),
          type: value.type.length === 1 ? 'object' : value.type,
        }
      else fail(`primitive ${value.name} has named children`)
    } else if (value.type.includes('object')) {
      // Video sources share fps/media_resolution across URL and base64 variants.
      out = {
        allOf: [
          objectSchema(children.filter((child) => child.isBold)),
          alternatives(children.filter((child) => !child.isBold)),
        ],
      }
    } else fail(`mixed native children in ${value.name}`)
  }
  if (value.description) {
    out.description = plain(value.description)
    const values = options(value.description)
    if (values && value.type.length === 1 && value.type[0] === 'string')
      out.enum = values
  }
  return out
}

export function nativeSchemas(text: string): Array<RecordValue> {
  const schemas: Array<RecordValue> = []
  for (const match of text.matchAll(
    /<InlineSchemaV2 schema=\{`([\s\S]*?)`\}/g,
  )) {
    const raw = (match[1] ?? '')
      .replace(/\\\\/g, '\\')
      .replace(/\\`/g, '`')
      .replace(/\\\$/g, '$')
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      fail('native schema is not valid JSON')
    }
    if (!Array.isArray(parsed) || !parsed.length)
      fail('native schema is not a nonempty node list')
    schemas.push(objectSchema(parsed.map(node)))
  }
  if (!schemas.length) fail('document contains no native schemas')
  return schemas
}

/** Actual documented endpoints; multiple model families share chat/completions. */
export function xiaomiSpec(
  docs: Array<{ text: string; url: string }>,
): OpenApiDocument {
  const grouped = new Map<
    string,
    { requests: Array<RecordValue>; responses: Array<RecordValue> }
  >()
  for (const doc of docs) {
    const address =
      /## Request Address\s*```(?:bash)?\s*(https:\/\/api\.xiaomimimo\.com\/[^\s`]+)\s*```/.exec(
        doc.text,
      )?.[1]
    if (!address) fail(`no native request address in ${doc.url}`)
    const path = new URL(address).pathname
    const parsed = nativeSchemas(doc.text)
    const request = parsed[0]
    const response = parsed[1]
    if (!request || !response)
      fail(`missing native request/response in ${doc.url}`)
    const group = grouped.get(path) ?? { requests: [], responses: [] }
    group.requests.push(request)
    group.responses.push(response)
    grouped.set(path, group)
  }
  const combine = (schemas: Array<RecordValue>) =>
    schemas.length === 1 ? schemas[0] : { anyOf: schemas }
  return {
    openapi: '3.1.0',
    info: { title: 'Xiaomi MiMo', version: 'native-docs' },
    servers: [{ url: 'https://api.xiaomimimo.com' }],
    paths: Object.fromEntries(
      [...grouped].map(([path, group]) => [
        path,
        {
          post: {
            requestBody: {
              required: true,
              content: {
                'application/json': { schema: combine(group.requests) },
              },
            },
            responses: {
              '200': {
                description: 'Documented non-streaming response',
                content: {
                  'application/json': { schema: combine(group.responses) },
                },
              },
            },
          },
        },
      ]),
    ),
  }
}
