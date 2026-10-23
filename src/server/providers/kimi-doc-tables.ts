/**
 * `<DocTable>` tables from a Kimi docs page (platform.kimi.com and
 * platform.kimi.ai, both Mintlify). As of 2026-10-20 the `.md` export of a
 * page renders each `<DocTable>` as an empty `<table>`, so the pricing
 * tables are read from the HTML page instead. Its RSC payload embeds the
 * page's compiled MDX: `_jsx(Heading,{level:`2`,…,children:`…`})` (or
 * `_components.h2`) for each heading and
 * `_jsx(DocTable,{columns:[…],rows:[[…]]})` for each table, with every
 * string a template literal. The payload carries the body twice: first
 * with a rendering `DocTable`, then with `DocTable=()=>null` (on
 * platform.kimi.ai that copy has no `rows`). Only the first copy, up to its
 * `_provideComponents(`, is read. As of 2026-10-23 a DocTable also carries
 * `className`, `corner` and `groups` (styling and a header row over the
 * column titles), a model id cell is a link, and a column title can be a
 * `Tooltip` over its text.
 */
import { closing, literalEnd } from './compiled-mdx.ts'

const LABEL = 'kimi docs'

export interface KimiDocTable {
  /** Text of the nearest level-1/2 heading above the table; null when not plain text. */
  section: string | null
  /** Text of the `###` heading under that section; null when none or not plain text. */
  subsection: string | null
  /** Column titles; null for a column whose title is not plain text. */
  titles: Array<string | null>
  /**
   * A cell is its text: a template literal, or a fragment of them joined
   * (`<>{"$"}0.16</>` compiles to `_jsxs(_Fragment,{children:[`$`,`0.16`]})`,
   * read as `$0.16`), or the text of a link or tooltip. Anything else (a
   * struck price) is null.
   */
  rows: Array<Array<string | null>>
}

/** A template literal with no escape or `${`: its text is the source text. */
const LITERAL = '`((?:[^`\\\\$]|\\$(?!\\{))*)`'
const TEXT = new RegExp(`^${LITERAL}$`)
const FRAGMENT = /^_jsxs?\(_Fragment,\{children:([\s\S]*)\}\)$/
/** A link or tooltip: its text is its `children`. */
const WRAPPER = /^_jsxs?\((?:_components\.a|Tooltip),\{/
const HEADING = /_jsxs?\((?:Heading|_components\.h(\d)),\{/g
const TABLE = /_jsxs?\(DocTable,\{/g
/** DocTable props that style it or group its titles; they move no cell. */
const STYLE_PROPS = new Set(['className', 'corner', 'groups'])

/** The comma-separated items between `open` and its closing bracket. */
function items(source: string, open: number): Array<string> {
  const close = closing(source, open, LABEL)
  const out: Array<string> = []
  let start = open + 1
  for (let i = start; i < close; i++) {
    const char = source[i]
    if (char === '`') {
      i = literalEnd(source, i, LABEL)
    } else if (char === '[' || char === '{' || char === '(') {
      i = closing(source, i, LABEL)
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
  const wrapper = WRAPPER.exec(item)
  if (wrapper) {
    const open = wrapper[0].length - 1
    if (closing(item, open, LABEL) !== item.length - 2) return null
    const children = props(item, open).get('children')
    return children === undefined ? null : cell(children)
  }
  const children = FRAGMENT.exec(item)?.[1]
  if (children === undefined) return null
  const parts = children.startsWith('[') ? items(children, 0) : [children]
  const texts = parts.map((part) => TEXT.exec(part)?.[1])
  return texts.every((part) => part !== undefined) ? texts.join('') : null
}

/** `key:value` props of the object literal opened at `open`. */
function props(source: string, open: number): Map<string, string> {
  const out = new Map<string, string>()
  for (const prop of items(source, open)) {
    const colon = prop.indexOf(':')
    if (colon > 0) out.set(prop.slice(0, colon), prop.slice(colon + 1))
  }
  return out
}

/**
 * Every DocTable on the page, in order, under the headings above it.
 * Throws when the page has no compiled MDX body or no DocTable, when a
 * heading's level is unreadable, when a DocTable's props are not `columns`
 * then `rows` beside the style props, or a row is not an array, or when
 * the body is malformed.
 */
export function parseKimiDocTables(html: string): Array<KimiDocTable> {
  const start = html.search(/_jsxs?\((?:Heading|DocTable|_components\.h\d),/)
  const end = start < 0 ? -1 : html.indexOf('_provideComponents(', start)
  if (end < 0) throw new Error('kimi docs: page has no compiled MDX body')
  const body = html.slice(start, end)

  const marks: Array<
    | { at: number; level: number; text: string | null }
    | { at: number; table: KimiDocTable }
  > = []
  for (const match of body.matchAll(HEADING)) {
    const heading = props(body, match.index + match[0].length - 1)
    const level = Number(
      match[1] ?? TEXT.exec(heading.get('level') ?? '')?.[1] ?? NaN,
    )
    if (!Number.isInteger(level)) {
      throw new Error('kimi docs: heading level is unreadable')
    }
    const children = heading.get('children')
    const text =
      children === undefined ? null : (TEXT.exec(children)?.[1] ?? null)
    marks.push({ at: match.index, level, text })
  }
  for (const match of body.matchAll(TABLE)) {
    const table = [...props(body, match.index + match[0].length - 1)].filter(
      ([key]) => !STYLE_PROPS.has(key),
    )
    const [columns, rows] = table.map(([, value]) => value)
    if (
      table.map(([key]) => key).join() !== 'columns,rows' ||
      !columns?.startsWith('[') ||
      !rows?.startsWith('[')
    ) {
      throw new Error('kimi docs: DocTable props are not columns, rows')
    }
    const titles = items(columns, 0).map((column) => {
      const title = column.startsWith('{')
        ? props(column, 0).get('title')
        : undefined
      return title === undefined ? null : cell(title)
    })
    const cells = items(rows, 0).map((row) => {
      if (!row.startsWith('[')) {
        throw new Error('kimi docs: DocTable row is not an array')
      }
      return items(row, 0).map(cell)
    })
    marks.push({
      at: match.index,
      table: { section: null, subsection: null, titles, rows: cells },
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
