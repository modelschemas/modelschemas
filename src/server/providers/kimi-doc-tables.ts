/**
 * `<DocTable>` tables from a Kimi docs page (platform.kimi.com and
 * platform.kimi.ai, both Mintlify). Since 2026-10-20 the `.md` export of a
 * page renders each `<DocTable>` as an empty `<table>`, so the pricing
 * tables are read from the HTML page instead. It embeds the page's compiled
 * MDX: `_jsx(Heading,{level:`2`,…,children:`…`})` for each heading and
 * `_jsx(DocTable,{columns:[…],rows:[[…]]})` for each table, with every
 * string a template literal. The body appears twice (server render and
 * client payload); only the first copy is read.
 */

export interface KimiDocTable {
  /** Text of the `##` heading above the table; null when not plain text. */
  section: string | null
  /** Text of the `###` heading under that section; null when none or not plain text. */
  subsection: string | null
  /** Column titles; null for a column whose title is not plain text. */
  titles: Array<string | null>
  /**
   * A cell is its text: a template literal, or a fragment of them joined
   * (`<>{"$"}0.16</>` compiles to [`$`,`0.16`]). Anything else is null.
   */
  rows: Array<Array<string | null>>
}

/** A template literal with no escape or `${`: its text is the source text. */
const LITERAL = '`((?:[^`\\\\$]|\\$(?!\\{))*)`'
const TEXT = new RegExp(`^${LITERAL}$`)
const FRAGMENT = /^_jsxs?\(_Fragment,\{children:(\[[\s\S]*\])\}\)$/
const HEADING = new RegExp(
  `_jsxs?\\((?:Heading,\\{level:\`(\\d)\`|_components\\.h(\\d),\\{)` +
    `(?:,?id:${LITERAL})?,?(?:children:${LITERAL}\\}\\))?`,
  'g',
)
const TITLE = new RegExp(`^\\{title:${LITERAL}`)
const TABLE = /_jsxs?\(DocTable,\{columns:\[/g

/** Index of the backtick closing the template literal opened at `open`. */
function literalEnd(source: string, open: number): number {
  for (let i = open + 1; i < source.length; i++) {
    if (source[i] === '\\') i++
    else if (source[i] === '`') return i
  }
  throw new Error('kimi docs: unterminated template literal')
}

/** Index of the bracket closing the one at `open`, skipping literals. */
function closing(source: string, open: number): number {
  let depth = 0
  for (let i = open; i < source.length; i++) {
    const char = source[i]
    if (char === '`') {
      i = literalEnd(source, i)
    } else if (char === '[' || char === '{' || char === '(') {
      depth++
    } else if (char === ']' || char === '}' || char === ')') {
      depth--
      if (depth === 0) return i
    }
  }
  throw new Error('kimi docs: unbalanced DocTable')
}

/** The comma-separated items between `open` and its closing bracket. */
function items(source: string, open: number): Array<string> {
  const close = closing(source, open)
  const out: Array<string> = []
  let start = open + 1
  for (let i = start; i < close; i++) {
    const char = source[i]
    if (char === '`') {
      i = literalEnd(source, i)
    } else if (char === '[' || char === '{' || char === '(') {
      i = closing(source, i)
    } else if (char === ',') {
      out.push(source.slice(start, i))
      start = i + 1
    }
  }
  if (close > start) out.push(source.slice(start, close))
  return out
}

function cell(item: string): string | null {
  const text = TEXT.exec(item)
  if (text) return text[1] ?? ''
  const children = FRAGMENT.exec(item)?.[1]
  if (children === undefined) return null
  const texts = items(children, 0).map((part) => TEXT.exec(part)?.[1])
  return texts.every((part) => part !== undefined) ? texts.join('') : null
}

/**
 * Every DocTable on the page, in order, under the headings above it.
 * Throws when the page has no compiled MDX body or no DocTable, or when a
 * DocTable's props are not `columns` then `rows`.
 */
export function parseKimiDocTables(html: string): Array<KimiDocTable> {
  const start = html.search(/_jsxs?\((?:Heading|DocTable),/)
  const end = start < 0 ? -1 : html.indexOf('_provideComponents(', start)
  if (end < 0) throw new Error('kimi docs: page has no compiled MDX body')
  const body = html.slice(start, end)

  const marks: Array<
    | { at: number; level: number; text: string | null }
    | { at: number; table: KimiDocTable }
  > = []
  for (const match of body.matchAll(HEADING)) {
    const level = Number(match[1] ?? match[2])
    marks.push({ at: match.index, level, text: match[4] ?? null })
  }
  for (const match of body.matchAll(TABLE)) {
    const columnsOpen = match.index + match[0].length - 1
    const columnsClose = closing(body, columnsOpen)
    if (!body.startsWith(',rows:[', columnsClose + 1)) {
      throw new Error('kimi docs: DocTable props are not columns, rows')
    }
    const titles = items(body, columnsOpen).map(
      (column) => TITLE.exec(column)?.[1] ?? null,
    )
    const rows = items(body, columnsClose + 7).map((row) =>
      row.startsWith('[') ? items(row, 0).map(cell) : [null],
    )
    marks.push({
      at: match.index,
      table: { section: null, subsection: null, titles, rows },
    })
  }
  marks.sort((a, b) => a.at - b.at)

  const tables: Array<KimiDocTable> = []
  let section: string | null = null
  let subsection: string | null = null
  for (const mark of marks) {
    if ('table' in mark) {
      tables.push({ ...mark.table, section, subsection })
    } else if (mark.level <= 2) {
      section = mark.text
      subsection = null
    } else if (mark.level === 3) {
      subsection = mark.text
    }
  }
  if (tables.length === 0) throw new Error('kimi docs: page has no DocTable')
  return tables
}
