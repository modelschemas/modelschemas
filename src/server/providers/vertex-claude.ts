/** Google-hosted Claude catalog; every id and fact is read from Google's cards. */
import { compileTokenCard } from '@modelschemas/rate-card'
import type { RateCard } from '@modelschemas/rate-card'
import { tagDocsFacts } from './fact-sources.ts'
import {
  cachedDocs,
  mapConcurrent,
  parseDay,
  tokenCount,
} from './model-facts.ts'
import { fetchText, sha256Text } from './types.ts'
import type { ModelInfo } from './types.ts'
import { VERTEX_PRICING_URL } from './vertex-pricing.ts'
import { htmlText, normModelName } from './vertex-text.ts'

const HOST = 'https://docs.cloud.google.com'
const ROOT = '/gemini-enterprise-agent-platform/models/partner-models/claude'
export const VERTEX_CLAUDE_URL = `${HOST}${ROOT}`
export const VERTEX_CLAUDE_REQUEST_URL = `${VERTEX_CLAUDE_URL}/use-claude`

export function claudeCardPaths(html: string): string[] {
  const article = html.match(/<article\b[\s\S]*?<\/article>/i)?.[0]
  if (!article) throw new Error('vertex claude: missing catalog article')
  const paths = [...article.matchAll(/href="([^"]+)"/g)].flatMap((match) => {
    const path = match[1] ?? ''
    return path.startsWith(`${ROOT}/`) &&
      /\/(?:opus|sonnet|haiku|fable)-[\d-]+$/.test(path)
      ? [path]
      : []
  })
  if (!paths.length) throw new Error('vertex claude: no linked model cards')
  return [...new Set(paths)]
}

function lines(html: string): string[] {
  return html
    .replace(/<style\b[\s\S]*?<\/style>|<script\b[\s\S]*?<\/script>/gi, '')
    .split(/<[^>]+>/)
    .map(htmlText)
    .filter(Boolean)
}

export function claudeCardModels(
  html: string,
  url: string,
  hash: string,
): ModelInfo[] {
  const article = html.match(/<article\b[\s\S]*?<\/article>/i)?.[0]
  if (!article) throw new Error('vertex claude: missing model article')
  const text = lines(article)
  const idAt = text.indexOf('Model ID')
  const rawId = text[idAt + 1]
  if (idAt < 0 || !rawId || !/^claude-[a-z0-9.@-]+$/.test(rawId)) {
    throw new Error(`vertex claude: unreadable model id ${url}`)
  }
  const limit = (label: string): number | null => {
    const entry = text.find((line) => line.startsWith(`${label}:`))
    if (!entry) return null
    const value = tokenCount(entry.slice(label.length + 1).trim())
    if (value === null) throw new Error(`vertex claude: unreadable ${label}`)
    return value
  }
  const inputAt = text.indexOf('Inputs:')
  const outputAt = text.indexOf('Outputs:')
  const tokenAt = text.indexOf('Token limits')
  const modalities = {
    Text: 'text',
    Code: 'text',
    Images: 'image',
    Image: 'image',
    Documents: 'pdf',
    Document: 'pdf',
    PDF: 'pdf',
  }
  const kinds = (items: string[]): string[] => [
    ...new Set(
      items.flatMap((item) => {
        if (item === ',') return []
        const kind = modalities[item as keyof typeof modalities]
        if (!kind) throw new Error(`vertex claude: unknown modality ${item}`)
        return [kind]
      }),
    ),
  ]
  const caps = text.slice(
    text.indexOf('Capabilities') + 1,
    text.indexOf('Usage types'),
  )
  const supportedAt = caps.indexOf('Supported')
  const unsupportedAt = caps.indexOf('Not supported')
  const supported =
    supportedAt >= 0 && unsupportedAt > supportedAt
      ? caps.slice(supportedAt + 1, unsupportedAt)
      : []
  const capabilities = [
    ...(supported.includes('Function calling') ? ['tools'] : []),
    ...(supported.includes('Extended thinking') ? ['reasoning'] : []),
    ...(supported.includes('Structured outputs') ? ['structured_outputs'] : []),
  ]
  const facts = {
    contextWindow: limit('Maximum input tokens'),
    maxOutput: limit('Maximum output tokens'),
    modalities:
      inputAt >= 0 && outputAt > inputAt && tokenAt > outputAt
        ? {
            input: kinds(text.slice(inputAt + 1, outputAt)),
            output: kinds(text.slice(outputAt + 1, tokenAt)),
          }
        : null,
    capabilities: capabilities.length ? capabilities : null,
    // Capability labels do not publish the accepted tools[].type wire ids.
    serverTools: null,
  }
  const title = htmlText(
    article.match(
      /<h1\b[^>]*>([\s\S]*?)<devsite-|<h1\b[^>]*>([\s\S]*?)<\/h1>/i,
    )?.[1] ?? '',
  ).replace(/ on Google Cloud$/, '')
  const versionsAt = text.indexOf('Versions')
  const versions =
    versionsAt < 0
      ? []
      : text.slice(versionsAt + 1, text.indexOf('Supported regions'))
  const ids = [
    ...new Set([
      rawId,
      ...versions.filter((line) => /^claude-[a-z0-9.@-]+$/.test(line)),
    ]),
  ]
  return ids.map((id) => {
    const at = versions.indexOf(id)
    const next = versions.findIndex(
      (line, index) => index > at && /^claude-/.test(line),
    )
    const block =
      at < 0 ? [] : versions.slice(at + 1, next < 0 ? undefined : next)
    const releaseAt = block.indexOf('Release date:')
    const release = releaseAt < 0 ? null : parseDay(block[releaseAt + 1] ?? '')
    return {
      rawId: id,
      displayName: title || null,
      activity: 'chat',
      ...facts,
      reasoning: null,
      requestMap: null,
      schemaEndpointId: null,
      releasedAt: release === null ? null : release / 1000,
      deprecated: block.some((line) => /^(Deprecated|Retired)$/i.test(line)),
      factSources: tagDocsFacts(facts, url, hash),
    }
  })
}

/** Only the explicitly Global Google price panel; no regional substitution. */
export function claudeGlobalPrices(
  html: string,
  source: RateCard['source'],
): Map<string, RateCard> {
  const globalTabs = [
    ...html.matchAll(/<button\b[^>]*role="tab"[^>]*>[\s\S]*?<\/button>/gi),
  ]
    .filter((match) => /^Global(?: endpoint)?$/i.test(htmlText(match[0])))
    .flatMap((match) => match[0].match(/\bid="([^"]+)"/)?.[1] ?? [])
  const out = new Map<string, RateCard>()
  for (const tab of globalTabs) {
    const panelAt = html.indexOf(`aria-labelledby="${tab}"`)
    if (panelAt < 0)
      throw new Error('vertex claude: missing Global price panel')
    const panelStart = html.lastIndexOf('<div', panelAt)
    let depth = 0
    let panelEnd = -1
    for (const tag of html.slice(panelStart).matchAll(/<\/?div\b[^>]*>/gi)) {
      depth += tag[0].startsWith('</') ? -1 : 1
      if (depth === 0) {
        panelEnd = panelStart + tag.index + tag[0].length
        break
      }
    }
    if (panelStart < 0 || panelEnd < 0)
      throw new Error('vertex claude: unreadable Global panel')
    const table = html
      .slice(panelStart, panelEnd)
      .match(/<table\b[\s\S]*?<\/table>/i)?.[0]
    if (!table || !/Claude/.test(table)) continue
    const rows = [...table.matchAll(/<tr\b[\s\S]*?<\/tr>/gi)].map((row) =>
      [...row[0].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) =>
        htmlText(cell[1] ?? ''),
      ),
    )
    const head = rows.shift() ?? []
    if (head[0] !== 'Model' || head[1] !== 'Type')
      throw new Error('vertex claude: unknown price columns')
    const groups = new Map<
      string,
      {
        base: Record<string, number>
        long: Record<string, number>
        threshold: number | null
      }
    >()
    let name = ''
    for (const row of rows) {
      if (row[0]) name = normModelName(row[0].replace(/^Claude\s+/i, ''))
      const type = row[1] ?? ''
      if (/batch/i.test(type)) continue
      const lever =
        type === 'Input'
          ? 'input_tokens'
          : type === 'Output'
            ? 'output_tokens'
            : type === 'Cache Hit'
              ? 'cache_read_tokens'
              : type === '5m Cache Write'
                ? 'cache_write_tokens'
                : /^1h(?:r)? Cache Write$/.test(type)
                  ? 'cache_write_1h_tokens'
                  : null
      if (!lever)
        throw new Error(`vertex claude: unknown Global price meter ${type}`)
      const group = groups.get(name) ?? { base: {}, long: {}, threshold: null }
      let found = false
      for (let index = 2; index < row.length; index++) {
        const cell = row[index] ?? ''
        if (!cell) continue
        if (!/^\$\d+(?:\.\d+)?$/.test(cell))
          throw new Error('vertex claude: unreadable price')
        const column = head[index] ?? ''
        const threshold = /([\d,]+)K input tokens/.exec(column)?.[1]
        if (!threshold) throw new Error('vertex claude: unreadable price tier')
        const bound = Number(threshold.replace(/,/g, '')) * 1000
        if (group.threshold !== null && group.threshold !== bound)
          throw new Error('vertex claude: conflicting price tiers')
        group.threshold = bound
        const target = / > /.test(` ${column} `) ? group.long : group.base
        const amount = Number(cell.slice(1)) / 1e6
        if (target[lever] !== undefined && target[lever] !== amount)
          throw new Error('vertex claude: conflicting price')
        target[lever] = amount
        found = true
      }
      if (!found) throw new Error('vertex claude: missing published price')
      groups.set(name, group)
    }
    for (const [key, group] of groups) {
      if (
        group.base.input_tokens === undefined ||
        group.base.output_tokens === undefined
      )
        throw new Error('vertex claude: incomplete rate card')
      const long = Object.keys(group.long).length ? group.long : null
      // A blank published tier cell does not authorize borrowing the short
      // price. Omit this model's card so its unsourced quote becomes null.
      if (
        long &&
        Object.keys(group.base).some((lever) => long[lever] === undefined)
      )
        continue
      const card = compileTokenCard(
        group.base,
        long && group.threshold !== null
          ? [{ minPromptTokens: group.threshold, rates: long }]
          : [],
        source,
      )
      if (!card) throw new Error('vertex claude: unrepresentable rate card')
      out.set(key, card)
    }
  }
  if (!out.size) throw new Error('vertex claude: no Global Claude price rows')
  return out
}

export async function vertexClaudeModels(
  kv?: KVNamespace,
): Promise<ModelInfo[]> {
  return cachedDocs(kv, VERTEX_CLAUDE_URL, async () => {
    const paths = claudeCardPaths(await fetchText(VERTEX_CLAUDE_URL))
    const rows = (
      await mapConcurrent(paths, 6, async (path) => {
        const url = `${HOST}${path}`
        const html = await fetchText(url)
        return claudeCardModels(html, url, await sha256Text(html))
      })
    ).flat()
    const pricesText = await fetchText(VERTEX_PRICING_URL)
    const hash = await sha256Text(pricesText)
    const prices = claudeGlobalPrices(pricesText, {
      url: VERTEX_PRICING_URL,
      hash,
      extractedAt: new Date().toISOString(),
    })
    const byId = new Map<string, ModelInfo>()
    for (const row of rows) {
      const pricing =
        prices.get(
          normModelName((row.displayName ?? '').replace(/^Claude\s+/i, '')),
        ) ?? null
      byId.set(row.rawId, {
        ...row,
        pricing,
        absent: { pricing: pricing ? undefined : 'cleared' },
        factSources: {
          ...row.factSources,
          ...tagDocsFacts({ pricing }, VERTEX_PRICING_URL, hash),
        },
      })
    }
    if (!byId.size) throw new Error('vertex claude: empty catalog')
    return [...byId.values()]
  })
}
