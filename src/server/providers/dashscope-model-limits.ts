/**
 * Context window and max output from a Model Studio model-info markdown
 * page. The listing leaves both null on a few chat rows; the page's
 * Context limits table publishes them. A page that parses nothing throws.
 * Thinking-mode and chain-of-thought lengths are not the max output.
 * Maximum input tokens are not the context window.
 */
import { markdownTableRows } from './model-facts.ts'
import { sha256Text } from './types.ts'

const PAGE_ORIGIN = 'https://www.alibabacloud.com/help/en/model-studio'

/**
 * alibabacloud.com answered the Worker's bare fetch with an HTML page from
 * 2026-10-07 (issue #256); workerd sends no User-Agent or Accept. These
 * match a browser's fetch of the `.md` URL. Since 2026-10-27 the portal
 * serves the rendered page to every client (issue #520); `dashscopeDocText`
 * reads either answer.
 */
export const DASHSCOPE_DOCS_INIT: RequestInit = {
  headers: {
    Accept: 'text/markdown,text/plain,*/*',
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  },
}

export interface DashscopeModelLimits {
  contextWindow: number | null
  maxOutput: number | null
}

export interface DashscopeLimitsDoc {
  sourceHash: string
  models: Record<string, DashscopeModelLimits>
}

const CONTEXT = /^context window$/i
const MAX_OUTPUT = /^max(?:imum)? output (?:length|tokens)$/i
const NOT_RESPONSE = /thinking|chain-of-thought|chain of thought/i

/** Dated snapshots are sections of the stable id's page. */
export function dashscopeModelPageUrl(rawId: string): string {
  const stable = rawId.replace(/-\d{4}-\d{2}-\d{2}$/, '')
  return `${PAGE_ORIGIN}/${stable.replace(/\./g, '-')}.md`
}

function cellText(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function headingText(line: string): string | null {
  const match = /^(#{1,6})\s+(.*)$/.exec(line)
  if (!match?.[2]) return null
  return match[2].replace(/<[^>]+>/g, '').trim()
}

function isModelId(text: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/i.test(text) && /[-.]/.test(text)
}

function sectionAfter(lines: Array<string>, start: number): string {
  const body: Array<string> = []
  for (let i = start; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i] ?? '')) break
    body.push(lines[i] ?? '')
  }
  return body.join('\n')
}

function htmlRows(section: string): Array<Array<string>> {
  const table = section.match(/<table[\s\S]*?<\/table>/i)?.[0]
  if (!table) return []
  const rows: Array<Array<string>> = []
  for (const row of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const rowHtml = row[1]
    if (!rowHtml) continue
    const cells = [
      ...rowHtml.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi),
    ].flatMap((cell) => {
      const html = cell[1]
      return html == null ? [] : [cellText(html)]
    })
    if (cells.length > 0) rows.push(cells)
  }
  return rows
}

function tableRows(section: string): Array<Array<string>> {
  const htmlAt = section.indexOf('<table')
  const markdownAt = section.search(/^\|/m)
  if (htmlAt >= 0 && (markdownAt < 0 || htmlAt < markdownAt)) {
    return htmlRows(section)
  }
  return markdownTableRows(section)
}

function wholeNumber(text: string): number | null {
  if (!/^[\d,]+$/.test(text)) return null
  const value = Number(text.replace(/,/g, ''))
  if (!Number.isInteger(value) || value < 0) return null
  return value
}

function limitsFrom(rows: Array<Array<string>>): DashscopeModelLimits | null {
  if (rows.length === 0) return null
  let contextWindow: number | null = null
  let maxOutput: number | null = null
  for (const row of rows) {
    for (let i = 0; i + 1 < row.length; i += 2) {
      const label = row[i] ?? ''
      if (label === '' || NOT_RESPONSE.test(label)) continue
      const value = wholeNumber(row[i + 1] ?? '')
      if (value === null) continue
      if (CONTEXT.test(label)) contextWindow = value
      else if (MAX_OUTPUT.test(label)) maxOutput = value
    }
  }
  return { contextWindow, maxOutput }
}

export function parseDashscopeModelLimits(
  markdown: string,
): Record<string, DashscopeModelLimits> {
  const lines = markdown.split('\n')
  let current: string | null = null
  const models: Record<string, DashscopeModelLimits> = {}
  for (let i = 0; i < lines.length; i++) {
    const title = headingText(lines[i] ?? '')
    if (!title) continue
    if (isModelId(title)) current = title
    if (!/^context limits$/i.test(title) || !current) continue
    const limits = limitsFrom(tableRows(sectionAfter(lines, i + 1)))
    if (limits) models[current] = limits
  }
  const parsed = Object.values(models)
  if (
    parsed.every((row) => row.contextWindow == null && row.maxOutput == null)
  ) {
    throw new Error('dashscope model page: parsed 0 context-limit rows')
  }
  return models
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCodePoint(Number(code)),
    )
    .replace(/&amp;/g, '&')
}

function inlineText(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The rendered help page's article, back in the shape the `.md` URL used
 * to serve: headings become `#` lines, `<code>` backticks, `<pre>` fences,
 * block elements line breaks. Tables stay HTML; the parsers read those as
 * the markdown carried them.
 */
function articleText(article: string): string {
  const tables: Array<string> = []
  const text = article
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
    .replace(
      /<table\b[\s\S]*?<\/table>/gi,
      (table) => `\n\uE000${String(tables.push(table) - 1)}\uE000\n`,
    )
    .replace(
      /<pre\b[^>]*>([\s\S]*?)<\/pre>/gi,
      (_, code: string) =>
        `\n\`\`\`\n${decodeEntities(code.replace(/<[^>]+>/g, ''))}\n\`\`\`\n`,
    )
    .replace(
      /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi,
      (_, level: string, inner: string) =>
        `\n${'#'.repeat(Number(level))} ${inlineText(inner)}\n`,
    )
    .replace(
      /<code\b[^>]*>([\s\S]*?)<\/code>/gi,
      (_, inner: string) => `\`${inner.replace(/<[^>]+>/g, '')}\``,
    )
    .replace(
      /<\/?(?:p|li|ul|ol|div|section|blockquote|br|dd|dt)\b[^>]*>/gi,
      '\n',
    )
    .replace(/<[^>]+>/g, '')
  return `${decodeEntities(text)
    .replace(
      /\uE000(\d+)\uE000/g,
      (_, index: string) => tables[Number(index)] ?? '',
    )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()}\n`
}

/**
 * The text the Model Studio parsers read: the body itself when it is
 * markdown, or the article of a rendered help page (issue #520) turned
 * back into that shape, under the page's h1 (`<product>:<title>`, outside
 * the article) as the markdown's `#` title. Throws on an HTML page with no
 * article (a challenge or an error page), naming its title and first 200
 * characters so the next failure shows what Alibaba served.
 */
export function dashscopeDocText(body: string, label: string): string {
  const text = body.trimStart()
  if (!text.startsWith('<')) return body
  const article = text.match(
    /<article\b[^>]*\bmarkdown-body\b[^>]*>([\s\S]*?)<\/article>/i,
  )?.[1]
  if (article) {
    const h1 = text.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1]
    const heading = h1
      ? `# ${inlineText(h1).replace(/^Alibaba Cloud Model Studio:/, '')}\n\n`
      : ''
    return heading + articleText(article)
  }
  const title = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim()
  const head = text.slice(0, 200).replace(/\s+/g, ' ')
  throw new Error(
    `${label}: response is HTML, not markdown` +
      (title ? ` (title: ${title})` : '') +
      `: ${head}`,
  )
}

export async function loadDashscopeModelLimits(
  body: string,
): Promise<DashscopeLimitsDoc> {
  const markdown = dashscopeDocText(body, 'dashscope model page')
  return {
    sourceHash: await sha256Text(markdown),
    models: parseDashscopeModelLimits(markdown),
  }
}
