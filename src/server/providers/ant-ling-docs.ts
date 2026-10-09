/** Ant Ling's direct API documentation. USD reseller tables are never ingested. */
import { compileTokenCard } from '@modelschemas/rate-card'
import type { RateCard } from '@modelschemas/rate-card'
import type { ModelInfo } from './types.ts'

export const ANT_ROOT = 'https://developer.ant-ling.com/en/docs/'
export const ANT_OPENAI = `${ANT_ROOT}api-reference/openai/`
export const ANT_OVERVIEW = `${ANT_ROOT}api-reference/`
export const ANT_PRICE = `${ANT_ROOT}models/price/`
export const ANT_LING = `${ANT_ROOT}models/ling/`
export const ANT_RING = `${ANT_ROOT}models/ring/`
export const ANT_EFFORT = `${ANT_ROOT}tutorials/effort/`
function fail(message: string): never {
  throw new Error(`ant-ling: ${message}`)
}
export function text(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}
export function article(html: string): string {
  const body = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/)?.[1]
  if (!body) fail('missing native article')
  return body
}
export function rows(html: string): Array<Array<string>> {
  return [...html.matchAll(/<tr\b[\s\S]*?<\/tr>/g)].map((row) =>
    [...row[0].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/g)].map(
      (cell) => cell[1] ?? '',
    ),
  )
}
function section(html: string, id: string): string {
  const s = html.match(
    new RegExp(
      `<h[234]\\b[^>]*id="${id}"[^>]*>[\\s\\S]*?<\\/h[234]>([\\s\\S]*?)(?=<h2\\b|$)`,
    ),
  )?.[1]
  if (s === undefined) fail(`missing ${id} section`)
  return s
}
export function blocks(html: string): Map<string, string> {
  const head = [...html.matchAll(/<h[34]\b[^>]*>[\s\S]*?<\/h[34]>/g)]
  return new Map(
    head.map((m, i) => [
      text(m[0]),
      html.slice(m.index + m[0].length, head[i + 1]?.index ?? html.length),
    ]),
  )
}
function options(block: string): Array<string> {
  const after = block.split(/<strong>Options<\/strong>:/)[1]
  if (after === undefined) return []
  return [
    ...(after.split('</ul>')[0]?.matchAll(/<code\b[^>]*>([^<]+)<\/code>/g) ??
      []),
  ].map((m) => text(m[1] ?? ''))
}
export function nativeFields(html: string): Map<string, string> {
  return blocks(section(article(html), 'request-body'))
}
export function nativeModelIds(html: string): Array<string> {
  const model = nativeFields(html).get('model')
  if (!model) fail('missing model parameter')
  const ids = options(model)
  if (!ids.length || new Set(ids).size !== ids.length)
    fail('unreadable native model options')
  return ids
}
export interface NativePrice {
  rates: Record<string, number>
  free: boolean
}
export function nativePrices(html: string): Map<string, NativePrice> {
  const body = section(article(html), 'model-pricing')
  if (!text(body).includes('All prices below are in CNY'))
    fail('direct pricing currency not CNY')
  const table = body.match(/<table\b[\s\S]*?<\/table>/)?.[0]
  if (!table) fail('missing direct price table')
  const all = rows(table)
  if (
    all[0]?.map(text).join('|') !==
    'Model|Use Case|Input (per 1M tokens)|Output (per 1M tokens)|Cache Read (per 1M tokens)'
  )
    fail('direct pricing headers changed')
  const out = new Map<string, NativePrice>()
  for (const row of all.slice(1)) {
    if (row.length !== 5) fail('direct price row missing cells')
    const id = text(row[0] ?? '')
    if (!id || out.has(id)) fail('missing or duplicate direct model ID')
    const amounts = row.slice(2).map((cell) => {
      const current = text(cell.replace(/<del\b[\s\S]*?<\/del>/g, ''))
      const price = /^¥(\d+(?:\.\d+)?)$/.exec(current)
      if (!price) fail('unreadable current CNY price')
      return Number(price[1]) / 1e6
    })
    const input = amounts[0],
      output = amounts[1],
      cache = amounts[2]
    if (input === undefined || output === undefined || cache === undefined)
      fail('missing direct price')
    out.set(id, {
      rates: {
        input_tokens: input,
        output_tokens: output,
        cache_read_tokens: cache,
      },
      free: amounts.every((a) => a === 0),
    })
  }
  if (!out.size) fail('direct price table empty')
  return out
}
export function priceCards(
  prices: Map<string, NativePrice>,
  source: RateCard['source'],
): Map<string, RateCard> {
  const out = new Map<string, RateCard>()
  for (const [id, quote] of prices) {
    // A constant zero is justified only when every current native quote is zero.
    const card = quote.free
      ? {
          inputs: {},
          tables: { rate: { base: quote.rates } },
          price: {
            currency: ['CNY', quote.rates.input_tokens],
          } as RateCard['price'],
          examples: [],
          source,
        }
      : compileTokenCard(quote.rates, [], source, { currency: 'CNY' })
    if (!card) fail('uncompilable direct price')
    out.set(id, card)
  }
  return out
}
export function nativeContexts(
  overview: string,
  ling: string,
): Map<string, number> {
  const out = new Map<string, number>()
  const body = section(article(overview), 'model-quick-overview')
  const table = body.match(/<table\b[\s\S]*?<\/table>/)?.[0]
  if (!table) fail('missing hosted context overview')
  const all = rows(table)
  if (all[0]?.map(text).join('|') !== 'Model Name|Context Window|Description')
    fail('context overview headers changed')
  const tokens = (value: string) => {
    const m = /^(\d+(?:\.\d+)?)(K|M)$/.exec(value)
    if (!m) fail('unreadable context')
    const limit = Number(m[1]) * (m[2] === 'K' ? 1e3 : 1e6)
    if (!Number.isSafeInteger(limit) || limit <= 0)
      fail('invalid context limit')
    return limit
  }
  for (const row of all.slice(1)) {
    if (row.length !== 3) fail('context row missing cells')
    out.set(text(row[0] ?? ''), tokens(text(row[1] ?? '')))
  }
  const selection = section(article(ling), 'model-selection-guide').match(
    /<table\b[\s\S]*?<\/table>/,
  )?.[0]
  if (!selection) fail('missing Ling model selection')
  for (const row of rows(selection).slice(1)) {
    const id = text(row[0] ?? '')
    const context = text(row[2] ?? '')
    if (context !== '—' && !out.has(id)) out.set(id, tokens(context))
  }
  return out
}
export function overviewContextIds(html: string): Set<string> {
  return new Set(
    rows(section(article(html), 'model-quick-overview'))
      .slice(1)
      .map((row) => text(row[0] ?? '')),
  )
}
type Schema = Record<string, unknown>
export function nativeRequest(html: string): Schema {
  const fields = nativeFields(html)
  const overview = fields.get('Overview')
  const table = overview?.match(/<table\b[\s\S]*?<\/table>/)?.[0]
  if (!table) fail('missing request overview')
  const all = rows(table).map((row) => row.map(text))
  if (all[0]?.join('|') !== 'Parameter|Type|Required|Default|Description')
    fail('request parameter table headers changed')
  const schema: Schema = { type: 'object', properties: {}, required: [] }
  const nodes = new Map<string, Schema>([['', schema]])
  const type = (name: string): Schema => {
    if (['string', 'boolean', 'object'].includes(name)) return { type: name }
    if (name === 'double') return { type: 'number' }
    if (name === 'object[]') return { type: 'array', items: { type: 'object' } }
    if (name === 'list')
      return { type: 'array', items: { 'x-source-type': null } }
    fail(`unknown native field type ${name}`)
  }
  for (const row of all.slice(1)) {
    if (row.length !== 5 || !['Yes', 'No'].includes(row[2] ?? ''))
      fail('request parameter row missing cells')
    const name = row[0] ?? ''
    const node = type(row[1] ?? '')
    node.description = row[4]
    const range = row[4]?.match(
      /([[(])\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*([\])])/,
    )
    if (range) {
      node[range[1] === '(' ? 'exclusiveMinimum' : 'minimum'] = Number(range[2])
      node[range[4] === ')' ? 'exclusiveMaximum' : 'maximum'] = Number(range[3])
    }
    const def = row[3]
    if (def !== undefined && def !== '—') {
      if (!def) fail('missing parameter default cell')
      if (def === 'true' || def === 'false') node.default = def === 'true'
      else if (Number.isFinite(Number(def))) node.default = Number(def)
      else fail('unknown parameter default')
    }
    const detail = fields.get(name)
    if (!detail) fail(`missing native detail for ${name}`)
    const values = options(detail)
    if (values.length) {
      // Native model options lag the direct pricing catalog. Preserve the list
      // as evidence without inventing a closed allowlist for newer native IDs.
      node[name === 'model' ? 'x-source-options' : 'enum'] = values
    }
    ;(schema.properties as Record<string, Schema>)[name] = node
    nodes.set(name, node)
    if (row[2] === 'Yes') (schema.required as Array<string>).push(name)
  }
  for (const [name, detail] of fields) {
    if (!name.includes('.')) continue
    const pieces = name.split('.')
    const leaf = pieces.pop()
    const parentKey = pieces.join('.')
    let parent = nodes.get(parentKey)
    if (!parent || !leaf) fail(`unresolved native nested field ${name}`)
    if (parent.type === 'array') parent = parent.items as Schema
    if (parent.type !== 'object') fail('nested field has non-object parent')
    const declared = detail.match(
      /<strong>Type<\/strong>: ([\s\S]*?)<\/li>/,
    )?.[1]
    if (!declared) fail('missing native nested type')
    const node = type(text(declared))
    // The same native page states that its VL model accepts image/video blocks,
    // contradicting the formal string-only content declaration. Preserve both
    // statements as source evidence; no block shape is published in this table.
    if (
      name === 'messages.content' &&
      /the request accepts text, images, and videos/.test(
        text(fields.get('model') ?? ''),
      )
    ) {
      delete node.type
      node['x-source-type'] = null
      node['x-source-declared-type'] = text(declared)
      node['x-source-conflicting-statement'] = text(fields.get('model') ?? '')
    }
    const values = options(detail)
    if (values.length) node.enum = values
    const def = detail.match(/default <code\b[^>]*>([^<]+)<\/code>/)?.[1]
    if (def !== undefined)
      node.default = def === 'true' ? true : def === 'false' ? false : def
    ;((parent.properties ??= {}) as Record<string, Schema>)[leaf] = node
    if (/<strong>Required<\/strong>/.test(detail))
      ((parent.required ??= []) as Array<string>).push(leaf)
    nodes.set(name, node)
  }
  return schema
}
export function applicability(html: string, field: string): string {
  const block = nativeFields(html).get(field)
  if (!block) fail(`missing ${field} applicability`)
  const t = text(block)
  const id = t.match(/Only (?:takes effect|effective) for ([\w.-]+)/i)?.[1]
  if (!id) fail(`unreadable ${field} applicability`)
  return id.replace(/\.$/, '')
}
export function controls(html: string) {
  const fields = nativeFields(html)
  const effort = fields.get('reasoning.effort')
  const toggle = fields.get('thinking.type')
  if (!effort || !toggle) fail('missing native reasoning controls')
  return {
    effortId: applicability(html, 'reasoning'),
    toggleId: applicability(html, 'thinking'),
    efforts: options(effort),
    effortDefault:
      effort.match(/default <code\b[^>]*>([^<]+)<\/code>/)?.[1] ?? null,
    toggles: options(toggle),
  }
}
export function antModelRows(
  api: string,
  pricing: string,
  contexts: Map<string, number>,
): Array<ModelInfo> {
  const apiIds = new Set(nativeModelIds(api))
  const ids = [...new Set([...apiIds, ...nativePrices(pricing).keys()])]
  return ids.map((rawId) => ({
    rawId,
    displayName: null,
    activity: apiIds.has(rawId) ? 'chat' : null,
    contextWindow: contexts.get(rawId) ?? null,
    maxOutput: null,
    modalities: null,
    pricing: null,
    reasoning: null,
    requestMap: null,
  }))
}
export function antSpec(api: string) {
  const all = rows(section(article(api), 'request-address')).map((row) =>
    row.map(text),
  )
  const route = all[1]
  if (all[0]?.join('|') !== 'Method|URL' || route?.[0] !== 'POST' || !route[1])
    fail('missing native request address')
  const url = new URL(route[1])
  if (url.origin !== 'https://api.ant-ling.com') fail('native API host changed')
  return {
    openapi: '3.1.0',
    info: { title: 'Ant Ling native API', version: 'source-derived' },
    paths: {
      [url.pathname]: {
        post: {
          requestBody: {
            required: true,
            content: { 'application/json': { schema: nativeRequest(api) } },
          },
          responses: {
            '200': {
              description:
                'The source publishes response examples but no response field schema.',
            },
          },
        },
      },
    },
  }
}
