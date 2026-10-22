/**
 * Provider deprecation pages (issue #410): when a model was deprecated, when
 * it shuts down, and what the provider says to use instead. Every value is
 * read off the page as written; a cell the parser cannot read throws, so a
 * reshaped page fails the source (`tryDocs`) instead of writing guesses.
 */
import type { DocsRun } from './model-facts.ts'
import { tryDocs } from './model-facts.ts'
import { fetchText } from './types.ts'
import type { ModelDeprecation } from './types.ts'

export const GROQ_DEPRECATIONS_URL =
  'https://console.groq.com/docs/deprecations.md'
export const MISTRAL_DEPRECATIONS_URL = 'https://docs.mistral.ai/models.md'

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
]

const MODEL_ID = /^[a-z0-9][a-z0-9._/:-]*$/

function utc(year: number, month: number, day: number, text: string): number {
  const ms = Date.UTC(year, month - 1, day)
  const date = new Date(ms)
  if (
    month < 1 ||
    month > 12 ||
    date.getUTCFullYear() !== year ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`deprecations: not a date: ${JSON.stringify(text)}`)
  }
  return ms / 1000
}

/** `August 24, 2026` → epoch seconds, or null when `text` is not one. */
function monthDayYear(text: string): number | null {
  const m = /^([A-Za-z]+) (\d{1,2}), (\d{4})$/.exec(text.trim())
  const month = m ? MONTHS.indexOf((m[1] ?? '').toLowerCase()) + 1 : 0
  if (!m || month === 0) return null
  return utc(Number(m[3]), month, Number(m[2]), text)
}

/** Table rows of a markdown block, header and divider dropped. */
function tableRows(block: string): Array<Array<string>> {
  const lines = block.split('\n').filter((line) => line.startsWith('|'))
  return lines.slice(2).map((line) =>
    line
      .slice(
        1,
        line.trimEnd().endsWith('|') ? line.trimEnd().length - 1 : undefined,
      )
      .split('|')
      .map((cell) => cell.trim()),
  )
}

function requireId(id: string, source: string): string {
  if (!MODEL_ID.test(id)) {
    throw new Error(`${source}: not a model id: ${JSON.stringify(id)}`)
  }
  return id
}

/**
 * Groq's deprecation history: one `###` section per shutdown, each with a
 * table of Model ID | Shutdown Date (`MM/DD/YY`) | Recommended Replacement
 * Model ID. A replacement cell names one or more ids (`a or b`, `a b`,
 * `a (text-only workloads)`), or `—` for none. The announcement date is
 * the section prose's "on <Month D, YYYY>, we emailed/announced"; a
 * section that states none, or only a month, leaves `deprecatedAt` null.
 * The page is newest first, so an id listed twice keeps its latest entry.
 */
export function parseGroqDeprecations(
  markdown: string,
): Array<ModelDeprecation> {
  const source = 'groq deprecations'
  const history = markdown.split(/^## \[Deprecation History\]/m)[1]
  if (history === undefined)
    throw new Error(`${source}: no Deprecation History`)
  const out = new Map<string, ModelDeprecation>()
  for (const section of history.split(/^### /m).slice(1)) {
    const announced =
      /\b[Oo]n ([A-Z][a-z]+ \d{1,2}, \d{4}), we (?:emailed|announced)\b/.exec(
        section,
      )?.[1]
    const deprecatedAt = announced ? monthDayYear(announced) : null
    const header = section
      .split('\n')
      .find((line) => line.startsWith('|'))
      ?.split('|')
      .map((cell) => cell.trim())
      .filter(Boolean)
    if (
      !header ||
      !/^(Deprecated Model|Model ID)$/.test(header[0] ?? '') ||
      header[1] !== 'Shutdown Date' ||
      header[2] !== 'Recommended Replacement Model ID'
    ) {
      throw new Error(
        `${source}: unexpected table in ${JSON.stringify(section.split('\n')[0])}`,
      )
    }
    for (const row of tableRows(section)) {
      if (row.length !== 3) {
        throw new Error(`${source}: row has ${String(row.length)} cells`)
      }
      const [rawId, shutdown, replacement] = row as [string, string, string]
      const date = /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/.exec(shutdown)
      if (!date) {
        throw new Error(`${source}: shutdown date ${JSON.stringify(shutdown)}`)
      }
      const replacedBy =
        replacement === '—' || replacement === ''
          ? null
          : replacement
              .replace(/\([^)]*\)/g, ' ')
              .split(/\s+/)
              .filter((word) => word !== '' && word !== 'or')
              .map((id) => requireId(id, source))
      requireId(rawId, source)
      if (out.has(rawId)) continue
      out.set(rawId, {
        rawId,
        deprecatedAt,
        retiresAt: utc(
          2000 + Number(date[3]),
          Number(date[1]),
          Number(date[2]),
          shutdown,
        ),
        replacedBy,
        sourceUrl: GROQ_DEPRECATIONS_URL,
      })
    }
  }
  if (out.size === 0) throw new Error(`${source}: parsed 0 model rows`)
  return [...out.values()]
}

/** Mistral date cell: `2026-05-22` or `April 30, 2026`; empty is unstated. */
function mistralDate(cell: string, source: string): number | null {
  if (cell === '') return null
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(cell)
  if (iso) return utc(Number(iso[1]), Number(iso[2]), Number(iso[3]), cell)
  const prose = monthDayYear(cell)
  if (prose === null) {
    throw new Error(`${source}: date ${JSON.stringify(cell)}`)
  }
  return prose
}

const LINKED = /^\[[^\]]+\]\((\/models\/[a-z0-9-]+)\)$/
const API_NAME = /^`([^`]+)`$/

/**
 * Mistral's Models Overview: the "Deprecated and retired models" table,
 * Model | API name | Status | Context | Summary | Deprecation | Retirement
 * | Replacement. The replacement is a link to a model page; its API name is
 * the one the same page's tables give that link, and null when no table
 * gives one. Rows with no API name name no callable id and are skipped. An
 * API name listed twice keeps its first (newest) row.
 */
export function parseMistralDeprecations(
  markdown: string,
): Array<ModelDeprecation> {
  const source = 'mistral deprecations'
  const [current, retired] = markdown.split(
    /^## Deprecated and retired models$/m,
  )
  if (retired === undefined) {
    throw new Error(`${source}: no "Deprecated and retired models" section`)
  }
  const header = retired
    .split('\n')
    .find((line) => line.startsWith('|'))
    ?.split('|')
    .map((cell) => cell.trim())
    .filter(Boolean)
    .join(' | ')
  const expected =
    'Model | API name | Status | Context | Summary | Deprecation | Retirement | Replacement'
  if (header !== expected) {
    throw new Error(`${source}: table header ${JSON.stringify(header)}`)
  }
  const apiNameOf = new Map<string, string>()
  for (const row of [...tableRows(current ?? ''), ...tableRows(retired)]) {
    const path = LINKED.exec(row[0] ?? '')?.[1]
    const id = API_NAME.exec(row[1] ?? '')?.[1]
    if (path && id && !apiNameOf.has(path)) apiNameOf.set(path, id)
  }
  const out = new Map<string, ModelDeprecation>()
  for (const row of tableRows(retired)) {
    if (row.length !== 8) {
      throw new Error(`${source}: row has ${String(row.length)} cells`)
    }
    const [, apiName, status, , , deprecation, retirement, replacement] =
      row as [string, string, string, string, string, string, string, string]
    if (status !== 'Deprecated' && status !== 'Retired') {
      throw new Error(`${source}: status ${JSON.stringify(status)}`)
    }
    if (apiName === '') continue
    const rawId = API_NAME.exec(apiName)?.[1]
    if (!rawId)
      throw new Error(`${source}: API name ${JSON.stringify(apiName)}`)
    requireId(rawId, source)
    let replacedBy: Array<string> | null = null
    if (replacement !== '') {
      const path = LINKED.exec(replacement)?.[1]
      if (!path) {
        throw new Error(`${source}: replacement ${JSON.stringify(replacement)}`)
      }
      const id = apiNameOf.get(path)
      replacedBy = id ? [id] : null
    }
    if (out.has(rawId)) continue
    out.set(rawId, {
      rawId,
      deprecatedAt: mistralDate(deprecation, source),
      retiresAt: mistralDate(retirement, source),
      replacedBy,
      sourceUrl: MISTRAL_DEPRECATIONS_URL,
    })
  }
  if (out.size === 0) throw new Error(`${source}: parsed 0 model rows`)
  return [...out.values()]
}

/** Load one deprecations page through `tryDocs`; null when it failed. */
export function loadDeprecations(
  run: DocsRun,
  kv: KVNamespace | undefined,
  url: string,
  parse: (markdown: string) => Array<ModelDeprecation>,
): Promise<Array<ModelDeprecation> | null> {
  return tryDocs(run, url, (cached) =>
    cached(kv, url, async () => parse(await fetchText(url))),
  )
}
