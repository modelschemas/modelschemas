/**
 * Context window and output cap from a Replicate model's own README
 * (`GET /v1/models/{owner}/{name}/readme`, markdown) and its listing
 * description. Only a spec line is read: a two-column table, a
 * `Context length:` label, or the phrase "N token context window".
 * A line that names two windows, or an approximate count, is not a count.
 * Several counts are kept only when they are the same number (a `262k`
 * beside `262,144` keeps the exact one).
 */
import { markdownTableRows } from './model-facts.ts'

const APPROX = /~|≈|\bapprox|\babout\b|\baround\b/i
const CONTEXT_LABEL = /^(context window|context length|context)$/i
const MAX_LABEL = /^max(?:imum)? output(?: tokens)?$/i
const LABELED =
  /^\s*[-*+]?\s*\**\s*(context window|context length)\s*\**\s*:\s*(.+)$/i
const TOKEN_WINDOW =
  /\b(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?\s+million|one million)\s+token context window\b/gi
/**
 * Abbreviation only (`262k context window`). A README aside uses the same
 * shape for a different model ("128K context window" in an eval note), so
 * this is read from the one-line listing description and not the README.
 */
const ABBREV_WINDOW = /\b(\d+(?:\.\d+)?)([kKmM])\s+context window\b/gi
const UP_TO_OUTPUT = /\bup to\s+([\d,]{4,})\s+output tokens\b/gi
const MAX_TOKENS_BULLET =
  /^\s*[-*]\s*`?max_tokens`?\b[^\n]*\boutput tokens?\b[^\n]*\bup to\s+([\d,]{4,})/i

export interface ReplicateReadmeFacts {
  contextWindow: number | null
  maxOutput: number | null
  context: { from: 'readme' | 'description'; path: string } | null
  max: { path: string } | null
}

interface Stated {
  value: number
  exact: boolean
  from: 'readme' | 'description'
  path: string
}

function normalizeLabel(cell: string): string {
  return cell.replace(/[*_`]/g, '').trim().toLowerCase().replace(/\s+/g, ' ')
}

function digits(text: string): number | null {
  const n = Number(text.replace(/,/g, ''))
  return Number.isInteger(n) && n > 0 ? n : null
}

/** One token count in a spec cell. Null when the cell is mixed or approximate. */
export function replicateTokenCount(text: string): number | null {
  const raw = text.replace(/[*_`]/g, ' ').replace(/\s+/g, ' ').trim()
  if (raw === '' || APPROX.test(raw)) return null
  const native = raw.match(
    /^([\d,]{4,})\s+(?:tokens?\s+)?natively(?:[,.]?\s+extensible up to\s+[\d,]+\s+tokens?)?\.?$/i,
  )
  const nativeCount = native?.[1] ? digits(native[1]) : null
  if (nativeCount) return nativeCount
  // "128K (extension to 512K)" is two windows, not one.
  if (/\bextension\b/i.test(raw)) return null

  const amounts: Array<number> = []
  for (const match of raw.matchAll(
    /(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)(?:\s+(million)|\s*([kKmM])\b)?/g,
  )) {
    const base = Number((match[1] ?? '').replace(/,/g, ''))
    if (!Number.isFinite(base)) continue
    const suffix = match[3]?.toLowerCase()
    if (match[2] || suffix === 'm') amounts.push(Math.round(base * 1_000_000))
    else if (suffix === 'k') amounts.push(Math.round(base * 1_000))
    else if ((match[1] ?? '').includes(',') || base >= 1000) {
      if (!Number.isInteger(base)) return null
      amounts.push(base)
    }
  }
  const [only] = [...new Set(amounts)]
  return amounts.length > 0 && new Set(amounts).size === 1
    ? (only ?? null)
    : null
}

function statedFrom(
  text: string,
  from: Stated['from'],
  path: string,
): Stated | null {
  const value = /^one million\b/i.test(text.trim())
    ? 1_000_000
    : replicateTokenCount(text)
  if (value === null) return null
  const exact = /\d{1,3}(?:,\d{3})+/.test(text) || /\b\d{5,}\b/.test(text)
  return { value, from, path, exact: exact && !/[kKmM]\s*$/.test(text.trim()) }
}

/** A `~` / "about" just before the phrase is an estimate, not a count. */
function phraseCount(
  line: string,
  match: RegExpMatchArray,
  from: Stated['from'],
): Stated | null {
  const index = match.index ?? 0
  if (
    APPROX.test(line.slice(Math.max(0, index - 8), index + match[0].length))
  ) {
    return null
  }
  const path = from === 'description' ? 'description' : 'token context window'
  return statedFrom(match[1] ?? '', from, path)
}

function withoutCode(markdown: string): string {
  return markdown.replace(/```[\s\S]*?```/g, '')
}

/**
 * A spec cell with digits that is not one count blocks the fact. A header
 * cell ("Input") is skipped.
 */
function takeCell(
  text: string,
  from: Stated['from'],
  path: string,
  into: Array<Stated>,
): boolean {
  if (!/\d/.test(text)) return false
  const stated = statedFrom(text, from, path)
  if (!stated) return true
  into.push(stated)
  return false
}

function pick(values: Array<Stated>): Stated | null {
  const [anchor] = values
  if (!anchor) return null
  const close = values.every(
    (row) =>
      Math.abs(row.value - anchor.value) / Math.max(row.value, anchor.value) <=
      0.01,
  )
  if (!close) return null
  return values.find((row) => row.exact) ?? anchor
}

export function replicateReadmeFacts(
  markdown: string,
  description = '',
): ReplicateReadmeFacts {
  // The README endpoint sends CRLF. A trailing CR keeps a table row from
  // ending on `|` and a labeled line from matching `$`.
  const readme = withoutCode(markdown.replace(/\r\n?/g, '\n'))
  const context: Array<Stated> = []
  const max: Array<Stated> = []
  let blockedContext = false
  let blockedMax = false

  for (const row of markdownTableRows(readme)) {
    const label = normalizeLabel(row[0] ?? '')
    const value = row.slice(1).join(' ')
    if (CONTEXT_LABEL.test(label)) {
      blockedContext =
        takeCell(value, 'readme', normalizeLabel(row[0] ?? ''), context) ||
        blockedContext
    } else if (MAX_LABEL.test(label)) {
      blockedMax =
        takeCell(value, 'readme', normalizeLabel(row[0] ?? ''), max) ||
        blockedMax
    }
  }

  for (const line of readme.split('\n')) {
    const labeled = line.match(LABELED)
    if (labeled?.[2]) {
      blockedContext =
        takeCell(
          labeled[2],
          'readme',
          normalizeLabel(labeled[1] ?? ''),
          context,
        ) || blockedContext
    }
    const bullet = line.match(MAX_TOKENS_BULLET)
    if (bullet?.[1]) {
      blockedMax =
        takeCell(bullet[1], 'readme', 'max_tokens', max) || blockedMax
    }
    for (const match of line.matchAll(UP_TO_OUTPUT)) {
      if (match[1]) {
        blockedMax =
          takeCell(match[1], 'readme', 'output tokens', max) || blockedMax
      }
    }
    for (const match of line.matchAll(TOKEN_WINDOW)) {
      const stated = phraseCount(line, match, 'readme')
      if (stated) context.push(stated)
    }
  }

  const blurb = description.replace(/\s+/g, ' ')
  for (const match of blurb.matchAll(TOKEN_WINDOW)) {
    const stated = phraseCount(blurb, match, 'description')
    if (stated) context.push(stated)
  }
  for (const match of blurb.matchAll(ABBREV_WINDOW)) {
    const index = match.index
    if (APPROX.test(blurb.slice(Math.max(0, index - 8), index))) continue
    const stated = statedFrom(
      `${match[1] ?? ''}${match[2] ?? ''}`,
      'description',
      'description',
    )
    if (stated) context.push({ ...stated, exact: false })
  }

  const contextWinner = blockedContext ? null : pick(context)
  const maxWinner = blockedMax ? null : pick(max)
  return {
    contextWindow: contextWinner?.value ?? null,
    maxOutput: maxWinner?.value ?? null,
    context: contextWinner
      ? { from: contextWinner.from, path: contextWinner.path }
      : null,
    max: maxWinner ? { path: maxWinner.path } : null,
  }
}
