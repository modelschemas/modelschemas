/** Meta's current hosted Model API documentation; no comparison catalogs. */
import { compileTokenCard } from '@modelschemas/rate-card'
import type { RateCard } from '@modelschemas/rate-card'
import type { ModelInfo } from './types.ts'

export const META_MODELS = 'https://dev.meta.ai/docs/models'
export const META_PRICING = 'https://dev.meta.ai/docs/pricing-rate-limits'
export const META_PROTOCOLS = 'https://dev.meta.ai/docs/protocols'
export const META_REASONING = 'https://dev.meta.ai/docs/reasoning'
export const META_REFERENCE = 'https://dev.meta.ai/docs/api-reference/'
function fail(message: string): never {
  throw new Error(`meta docs: ${message}`)
}
export function plain(text: string): string {
  return text
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
/** Only server-rendered article content, excluding navigation and hydration. */
export function article(html: string): string {
  const start = html.indexOf('<h1')
  if (start < 0) fail('missing article heading')
  return html.slice(start).split('<script')[0] ?? ''
}
export function tables(html: string): Array<Array<Array<string>>> {
  return [...html.matchAll(/<table\b[\s\S]*?<\/table>/gi)].map((table) =>
    [...table[0].matchAll(/<tr\b[\s\S]*?<\/tr>/gi)].map((row) =>
      [...row[0].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) =>
        plain(cell[1] ?? ''),
      ),
    ),
  )
}
function sections(
  html: string,
  level: number,
): Array<{ name: string; id: string; body: string }> {
  const source = article(html)
  const heads = [
    ...source.matchAll(
      new RegExp(
        `<h${level}\\b[^>]*id="([^"]+)"[^>]*>([\\s\\S]*?)<\\/h${level}>`,
        'gi',
      ),
    ),
  ]
  return heads.map((head, i) => ({
    name: plain(head[2] ?? ''),
    id: head[1] ?? '',
    body: source.slice(
      head.index + head[0].length,
      heads[i + 1]?.index ?? source.length,
    ),
  }))
}
const csv = (value: string) =>
  value.split(',').map((x) =>
    x
      .trim()
      .replace(/\*$/, '')
      .toLowerCase()
      .replace(/^text (?:prompt|transcript)$/, 'text'),
  )
export function parseMetaModels(html: string): Array<ModelInfo> {
  const out: Array<ModelInfo> = []
  const seen = new Set<string>()
  for (const section of sections(html, 2))
    for (const rows of tables(section.body)) {
      const head = rows[0] ?? []
      if (head[0] !== 'Model ID') continue
      const inputCol = head.findIndex(
        (h) => h === 'Input modalities' || h === 'Input',
      )
      const outputCol = head.findIndex(
        (h) => h === 'Output modalities' || h === 'Output',
      )
      if (inputCol < 0 || outputCol < 0) fail('model modality headers changed')
      for (const row of rows.slice(1)) {
        const rawId = row[0] ?? ''
        if (
          row.length !== head.length ||
          !rawId ||
          !/^[a-z0-9][a-z0-9.-]*$/.test(rawId) ||
          seen.has(rawId)
        )
          fail('invalid or duplicate model row')
        seen.add(rawId)
        const input = row[inputCol]
        const output = row[outputCol]
        if (!input || !output) fail('missing model modalities')
        const contextCol = head.indexOf('Context window')
        const context =
          contextCol < 0
            ? null
            : Number(
                (row[contextCol] ?? '')
                  .replace(/ tokens$/, '')
                  .replace(/,/g, ''),
              )
        if (
          context !== null &&
          (!Number.isSafeInteger(context) || context <= 0)
        )
          fail('unreadable model context')
        const activity = head.includes('Tier')
          ? 'chat'
          : output === 'Image'
            ? 'image'
            : section.name === 'Muse Voice Transcribe'
              ? 'audio'
              : null
        out.push({
          rawId,
          displayName: head.includes('Family') ? (row[1] ?? null) : null,
          activity,
          modalities: { input: csv(input), output: csv(output) },
          contextWindow: context,
          maxOutput: null,
          capabilities: [
            ...section.body.matchAll(
              /href="(\/docs\/(?:tool-calling|structured-output|reasoning))"/g,
            ),
          ]
            .map((m) =>
              m[1] === '/docs/tool-calling'
                ? 'tools'
                : m[1] === '/docs/structured-output'
                  ? 'structured_outputs'
                  : 'reasoning',
            )
            .filter((flag, i, all) => all.indexOf(flag) === i),
          pricing: null,
          reasoning: null,
          providerMetadata: {
            family: section.name,
            ...(head.includes('Tier')
              ? { tier: row[head.indexOf('Tier')] }
              : {}),
          },
        })
      }
    }
  if (!out.length) fail('model table listed no models')
  return out
}
export function parseMetaPricing(
  html: string,
  models: Array<ModelInfo>,
  source: RateCard['source'],
): Map<string, RateCard> {
  const cards = new Map<string, RateCard>()
  for (const section of sections(html, 3)) {
    const sourceIds = [
      ...section.body.matchAll(/<code\b[^>]*>([^<]+)<\/code>/g),
    ]
      .map((m) => plain(m[1] ?? ''))
      .filter((id) => models.some((model) => model.rawId === id))
    const rows = tables(section.body)[0]
    if (rows?.[0]?.join('|') === 'Usage|Price per 1M tokens') {
      if (!sourceIds.length) fail('token pricing has no native model IDs')
      const rates: Record<string, number> = {}
      const meters: Record<string, string> = {
        'Cached input': 'cache_read_tokens',
        Input: 'input_tokens',
        Output: 'output_tokens',
      }
      for (const row of rows.slice(1)) {
        const key = meters[row[0] ?? '']
        const price = /^\$(\d+(?:\.\d+)?)$/.exec(row[1] ?? '')
        if (!key || !price || row.length !== 2) fail('unreadable token price')
        rates[key] = Number(price[1]) / 1e6
      }
      if (!('input_tokens' in rates) || !('output_tokens' in rates))
        fail('incomplete token pricing')
      for (const id of sourceIds) {
        if (cards.has(id)) fail('duplicate model price')
        const card = compileTokenCard(rates, [], source)
        if (!card) fail('uncompilable token price')
        cards.set(id, card)
      }
    } else {
      const matches = models.filter((model) => {
        const metadata = model.providerMetadata as { family?: string }
        return section.name.includes(metadata.family ?? '\u0000')
      })
      if (!matches.length) continue
      const rates: Record<string, number> = {}
      const text = plain(section.body)
      if (rows?.[0]?.join('|') === 'Usage|Price')
        for (const row of rows.slice(1)) {
          const value = row[1] ?? ''
          if (row[0] === 'Audio processed') {
            const p = /^\$(\d+(?:\.\d+)?) per hour$/.exec(value)
            if (!p) fail('unreadable audio price')
            rates.audio_seconds = Number(p[1]) / 3600
          } else if (
            row[0] === 'Image segmentation' ||
            row[0] === 'Video segmentation'
          ) {
            const p = /^\$(\d+(?:\.\d+)?) per ([\d,]+) (images|frames)$/.exec(
              value,
            )
            if (!p) fail('unreadable segmentation price')
            rates[p[3] === 'images' ? 'segmented_images' : 'video_frames'] =
              Number(p[1]) / Number(p[2]?.replace(/,/g, ''))
          } else fail('unknown priced usage')
        }
      else if (section.name.includes('Image generation')) {
        const p = /flat \$(\d+(?:\.\d+)?) per generated image/.exec(text)
        if (!p) fail('unreadable image price')
        rates.generated_images = Number(p[1])
      } else continue
      const card = compileTokenCard(rates, [], source)
      if (!card) fail('uncompilable unit pricing')
      for (const model of matches) cards.set(model.rawId, card)
    }
  }
  if (!cards.size) fail('pricing parsed no rates')
  return cards
}

// A mechanical translation of Meta's own schema tables. Unknown types throw.
type Schema = Record<string, unknown>
const nameKey = (s: string) => s.replace(/[^a-z0-9]/gi, '').toLowerCase()
export function parseMetaSchemas(html: string): Record<string, Schema> {
  const blocks = sections(html, 3)
  const names = new Map(blocks.map((b) => [nameKey(b.name), b.id]))
  const out: Record<string, Schema> = {}
  const typeOf = (text: string): Schema => {
    if (text === '') return { 'x-source-type': null }
    const union = text.split(/\s*\|\s*/)
    if (union.length > 1) return { anyOf: union.map(typeOf) }
    if (text.startsWith('array of '))
      return { type: 'array', items: typeOf(text.slice(9)) }
    if (text.startsWith('enum (')) {
      const values = [...text.matchAll(/'([^']*)'/g)].map((m) => m[1])
      if (!values.length) fail('unreadable enum')
      return { type: 'string', enum: values }
    }
    const primitive =
      /^(string|integer|number|boolean|object|null)(?: \((uri|unixtime|binary|int64|int32)\))?$/.exec(
        text,
      )
    if (primitive)
      return {
        type: primitive[1],
        ...(primitive[2] && primitive[2] !== 'unixtime'
          ? { format: primitive[2] }
          : {}),
      }
    const id = names.get(nameKey(text))
    if (!id) fail(`unknown schema type ${text}`)
    return { $ref: `#/components/schemas/${id}` }
  }
  for (const block of blocks) {
    const rows = tables(block.body)[0]
    if (rows?.[0]?.join('|') === 'Field|Type|Required|Description') {
      const schema: Schema = { type: 'object', properties: {} }
      const nodes = new Map<string, Schema>([['', schema]])
      for (const row of rows.slice(1)) {
        if (row.length !== 4 || !['Yes', 'No'].includes(row[2] ?? ''))
          fail('schema field row changed')
        const field = row[0] ?? ''
        const pieces = field.split('.')
        const leaf = pieces.pop()
        const parentPath = pieces.join('.')
        let parent = nodes.get(parentPath)
        if (!parent || !leaf) fail(`unresolved nested field ${field}`)
        // A nullable object has its object branch in anyOf.
        if (Array.isArray(parent.anyOf)) {
          parent = (parent.anyOf as Array<Schema>).find(
            (s) => s.type === 'object',
          )
          if (!parent) fail(`non-object parent ${field}`)
        }
        if (parent.type === 'array') parent = parent.items as Schema
        if (parent.type !== 'object') fail(`non-object field parent ${field}`)
        const node = typeOf(row[1] ?? '')
        const description = row[3] ?? ''
        node.description = description
        for (const m of description.matchAll(
          /\b(minimum|maximum|minItems|maxItems|minLength|maxLength): (-?\d+(?:\.\d+)?)/g,
        ))
          node[m[1] ?? ''] = Number(m[2])
        const def = description.match(
          /\bdefault: (true|false|-?\d+(?:\.\d+)?)/,
        )?.[1]
        if (def !== undefined)
          node.default =
            def === 'true' ? true : def === 'false' ? false : Number(def)
        const properties = (parent.properties ??= {}) as Record<string, Schema>
        properties[leaf.replace(/\[\]$/, '')] = node
        if (row[2] === 'Yes') {
          const required = (parent.required ??= []) as Array<string>
          required.push(leaf.replace(/\[\]$/, ''))
        }
        nodes.set(field, node)
        if (node.type === 'array') nodes.set(`${field}[]`, node)
        if (leaf.endsWith('[]')) nodes.set(field.replace(/\[\]$/, ''), node)
      }
      out[block.id] = schema
    } else {
      const alias = [...block.body.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)]
        .map((p) => plain(p[1] ?? ''))
        .find((p) => p.startsWith('Type: '))
      if (!alias) fail(`schema ${block.name} has no table or type`)
      out[block.id] = typeOf(alias.slice(6))
    }
  }
  if (!Object.keys(out).length) fail('no native schema definitions')
  return out
}
export function metaOperation(
  html: string,
  schemas: Record<string, Schema>,
): { path: string; operation: Schema } {
  const source = article(html)
  const text = plain(source)
  const endpoint = text.match(/\bPOST (\/[^ ]+)/)?.[1]
  if (!endpoint) fail('missing native POST endpoint')
  const request = source
    .split('id="request-body"')[1]
    ?.split('id="response"')[0]
  const response = source.split('id="response"')[1]
  const content = (block: string | undefined): Record<string, unknown> => {
    if (!block) fail('missing native content block')
    const contentHeads = [...block.matchAll(/<h4\b[^>]*>[\s\S]*?<\/h4>/g)]
    const out: Record<string, unknown> = {}
    for (const [i, heading] of contentHeads.entries()) {
      const media = plain(heading[0]).match(/^Content Type: ([\w/+.-]+)$/)?.[1]
      if (!media) fail('unreadable native content type')
      const body =
        block
          .slice(
            heading.index + heading[0].length,
            contentHeads[i + 1]?.index ?? block.length,
          )
          .split(/<h3\b/)[0] ?? ''
      const id = body.match(/href="[^"#]*\/schemas#([^"]+)"/)?.[1]
      let schema: Schema
      if (id) {
        if (!schemas[id]) fail('missing native schema reference')
        schema = { $ref: `#/components/schemas/${id}` }
      } else {
        // ASR publishes an inline `object`, without a field/type table. Keep
        // that exact declared shape unconstrained; do not invent multipart fields.
        const inline = [...body.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)]
          .map((p) => plain(p[1] ?? ''))
          .find((p) => p === 'object')
        if (!inline) fail('missing native schema reference')
        schema = { type: 'object', 'x-source-fields': null }
      }
      out[media] = { schema }
    }
    if (!Object.keys(out).length) fail('missing native content types')
    return out
  }
  if (!plain(response ?? '').includes('HTTP 200'))
    fail('missing native successful response')
  return {
    path: `/v1${endpoint}`,
    operation: {
      requestBody: { required: true, content: content(request) },
      responses: {
        '200': {
          description: 'Native documented response',
          content: content(response),
        },
      },
    },
  }
}
