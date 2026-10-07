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
  for (const row of table.matchAll(/<tr>([\s\S]*?)<\/tr>/gi)) {
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
    parsed.length === 0 ||
    parsed.every((row) => row.contextWindow == null && row.maxOutput == null)
  ) {
    throw new Error('dashscope model page: parsed 0 context-limit rows')
  }
  return models
}

export async function loadDashscopeModelLimits(
  markdown: string,
): Promise<DashscopeLimitsDoc> {
  if (markdown.trimStart().startsWith('<')) {
    throw new Error('dashscope model page: response is HTML, not markdown')
  }
  return {
    sourceHash: await sha256Text(markdown),
    models: parseDashscopeModelLimits(markdown),
  }
}
