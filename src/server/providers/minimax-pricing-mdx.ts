/**
 * The price section of a MiniMax pricing overview, read from the HTML page.
 * As of 2026-10-21 both `llms-full.txt` and the `.md` export render each
 * `<Tab>` title as a bold line and drop the struck list price and its
 * badge (#399), which leaves no way to tell the tiers apart or a standing
 * price from a promotion. The HTML page's RSC payload still embeds the
 * compiled MDX: `self.__next_f.push([1,"…"])`, a JSON string holding the
 * module source, whose `_createMdxContent` returns a JSX tree with every
 * string a template literal.
 *
 * This parses that tree and renders the `## <heading>` section back to the
 * MDX `parseMinimaxPricing` reads: tabs, accordions, callouts, and headings
 * as themselves, tables as `|` rows, `del` as `~~`, a badge `<span>` with
 * its class. An element it does not know, or a value it cannot read,
 * throws: nothing is guessed about a component it has not seen.
 */
import { literalEnd } from './compiled-mdx.ts'

interface MdxElement {
  kind: 'element'
  /** `Tab`, `Heading`, …; `_components.p` and `` `br` `` are `p` and `br`. */
  type: string
  props: Record<string, MdxValue>
}

interface MdxObject {
  kind: 'object'
  props: Record<string, MdxValue>
}

type MdxValue =
  | string
  | number
  | boolean
  | null
  | MdxElement
  | MdxObject
  | Array<MdxValue>

const IDENTIFIER = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?/
const SCALAR = /^(?:true|false|null|-?\d+(?:\.\d+)?)(?![\w$])/
const ESCAPES: Record<string, string> = {
  n: '\n',
  t: '\t',
  '\\': '\\',
  '`': '`',
  $: '$',
}

/** A reader over the subset of JS the MDX compiler emits for a body. */
class MdxReader {
  constructor(
    private readonly source: string,
    private at: number,
    private readonly label: string,
  ) {}

  private fail(what: string): never {
    throw new Error(`${this.label}: ${what} in the compiled MDX`)
  }

  private skip(): void {
    while (/\s/.test(this.source[this.at] ?? '')) this.at++
  }

  private next(token: string): boolean {
    this.skip()
    if (!this.source.startsWith(token, this.at)) return false
    this.at += token.length
    return true
  }

  private expect(token: string): void {
    if (!this.next(token)) this.fail(`expected \`${token}\``)
  }

  /** `` `…` ``: `\n`, `\t`, `\\`, `` \` ``, `\$`, `\uXXXX`; no `${`. */
  private literal(): string {
    const end = literalEnd(this.source, this.at, this.label)
    const raw = this.source.slice(this.at + 1, end)
    this.at = end + 1
    if (raw.includes('${')) this.fail('a template literal with `${`')
    return raw.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_whole, escape: string) => {
      if (escape.length === 5) {
        return String.fromCharCode(parseInt(escape.slice(1), 16))
      }
      const char = ESCAPES[escape]
      return char ?? this.fail(`the escape \\${escape}`)
    })
  }

  private string(): string {
    let end = this.at + 1
    while (end < this.source.length && this.source[end] !== '"') {
      end += this.source[end] === '\\' ? 2 : 1
    }
    const text = JSON.parse(this.source.slice(this.at, end + 1)) as string
    this.at = end + 1
    return text
  }

  private key(): string {
    this.skip()
    if (this.source[this.at] === '"') return this.string()
    const name = IDENTIFIER.exec(this.source.slice(this.at))?.[0]
    if (!name || name.includes('.')) this.fail('an unreadable key')
    this.at += name.length
    return name
  }

  private object(): Record<string, MdxValue> {
    this.expect('{')
    const props: Record<string, MdxValue> = {}
    while (!this.next('}')) {
      const key = this.key()
      this.expect(':')
      props[key] = this.value()
      if (!this.next(',')) {
        this.expect('}')
        break
      }
    }
    return props
  }

  private array(): Array<MdxValue> {
    this.expect('[')
    const items: Array<MdxValue> = []
    while (!this.next(']')) {
      items.push(this.value())
      if (!this.next(',')) {
        this.expect(']')
        break
      }
    }
    return items
  }

  private element(): MdxElement {
    this.skip()
    let type: string
    if (this.source[this.at] === '`') type = this.literal()
    else {
      const name = IDENTIFIER.exec(this.source.slice(this.at))?.[0]
      if (!name) this.fail('an unreadable element type')
      this.at += name.length
      type = name.replace(/^_components\./, '')
    }
    this.expect(',')
    const props = this.object()
    this.expect(')')
    return { kind: 'element', type, props }
  }

  value(): MdxValue {
    this.skip()
    const char = this.source[this.at]
    if (char === '`') return this.literal()
    if (char === '"') return this.string()
    if (char === '[') return this.array()
    if (char === '{') return { kind: 'object', props: this.object() }
    if (this.next('_jsxs(') || this.next('_jsx(')) return this.element()
    const scalar = SCALAR.exec(this.source.slice(this.at))?.[0]
    if (scalar === undefined) this.fail('an unreadable value')
    this.at += scalar.length
    return JSON.parse(scalar) as MdxValue
  }
}

/**
 * The module source the page's RSC payload carries as a JSON string.
 * Throws unless exactly one payload chunk holds a `_createMdxContent`.
 */
function mdxModule(html: string, label: string): string {
  const marker = 'function _createMdxContent('
  const at = html.indexOf(marker)
  if (at < 0) throw new Error(`${label}: page has no compiled MDX body`)
  if (html.includes(marker, at + 1)) {
    throw new Error(`${label}: page carries the compiled MDX twice`)
  }
  const push = 'self.__next_f.push([1,'
  const open = html.lastIndexOf(push, at) + push.length
  if (open < push.length || html[open] !== '"') {
    throw new Error(`${label}: compiled MDX is not in an RSC payload string`)
  }
  let close = open + 1
  while (close < html.length && html[close] !== '"') {
    close += html[close] === '\\' ? 2 : 1
  }
  return JSON.parse(html.slice(open, close + 1)) as string
}

function isElement(value: MdxValue, type?: string): value is MdxElement {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    value.kind === 'element' &&
    (type === undefined || value.type === type)
  )
}

function isHeading(value: MdxValue, text?: string): boolean {
  return (
    isElement(value, 'Heading') &&
    value.props.level === '2' &&
    (text === undefined || value.props.children === text)
  )
}

/** Every array in the tree that holds the `## <heading>` element. */
function sectionsOf(value: MdxValue, heading: string): Array<Array<MdxValue>> {
  if (Array.isArray(value)) {
    const own = value.some((item) => isHeading(item, heading)) ? [value] : []
    return [...own, ...value.flatMap((item) => sectionsOf(item, heading))]
  }
  if (typeof value === 'object' && value !== null) {
    return Object.values(value.props).flatMap((prop) =>
      sectionsOf(prop, heading),
    )
  }
  return []
}

const CALLOUTS = new Set([
  'Note',
  'Info',
  'Tip',
  'Warning',
  'Check',
  'Danger',
  'Callout',
])

/** The MDX for one value of the section; throws on what it does not read. */
function render(value: MdxValue, label: string): string {
  const fail = (what: string): never => {
    throw new Error(`${label}: ${what} in the price section is not read`)
  }
  if (typeof value === 'string') return value.replace(/\*/g, '\\*')
  if (Array.isArray(value)) {
    return value.map((item) => render(item, label)).join('')
  }
  if (!isElement(value)) return fail(`the value ${JSON.stringify(value)}`)
  const { type, props } = value
  const children = () =>
    props.children === undefined ? '' : render(props.children, label)
  const text = (key: string): string => {
    const prop = props[key]
    if (typeof prop !== 'string' || /["\n]/.test(prop)) {
      return fail(`<${type}> ${key}`)
    }
    return prop
  }
  switch (type) {
    case '_Fragment':
      return children()
    case 'p':
      return `\n\n${children()}\n\n`
    case 'a':
      return `[${children()}](${text('href')})`
    case 'strong':
      return `**${children()}**`
    case 'em':
      return `*${children()}*`
    case 'del':
      return `~~${children()}~~`
    case 'code':
      return `\`${children()}\``
    case 'br':
      return '<br />'
    case 'span': {
      // A span with only a style is layout (`white-space: nowrap`); one
      // with a class is a badge, kept so the parser can read its text.
      const keys = Object.keys(props).filter((key) => key !== 'children')
      if (keys.every((key) => key === 'style')) return children()
      if (keys.join() !== 'className') return fail('<span> props')
      return `<span className="${text('className')}">${children()}</span>`
    }
    case 'ol':
    case 'ul':
      return `\n\n${children()}\n\n`
    case 'li':
      return `\n- ${children()}`
    case 'Table':
      return `\n\n${table(value, label).join('\n')}\n\n`
    case 'Tabs':
      return `\n\n<Tabs>\n${children()}\n</Tabs>\n\n`
    case 'Tab':
      return `\n<Tab title="${text('title')}">\n${children()}\n</Tab>\n`
    case 'Accordion':
      return `\n\n<Accordion title="${text('title')}">\n${children()}\n</Accordion>\n\n`
    case 'Heading':
      return `\n\n${'#'.repeat(Number(text('level')))} ${children()}\n\n`
    case 'section':
    case 'div':
      return `\n\n<${type}>\n${children()}\n</${type}>\n\n`
    default:
      if (CALLOUTS.has(type)) {
        return `\n\n<${type}>\n${children()}\n</${type}>\n\n`
      }
      return fail(`<${type}>`)
  }
}

/** A `<Table>` as `|` rows, with the separator under its head row. */
function table(element: MdxElement, label: string): Array<string> {
  const fail = (what: string): never => {
    throw new Error(`${label}: ${what} in a price table is not read`)
  }
  const list = (value: MdxValue | undefined): Array<MdxValue> =>
    value === undefined ? [] : Array.isArray(value) ? value : [value]
  const lines: Array<string> = []
  for (const part of list(element.props.children)) {
    if (!isElement(part) || (part.type !== 'thead' && part.type !== 'tbody')) {
      return fail('a table part')
    }
    for (const row of list(part.props.children)) {
      if (!isElement(row, 'tr')) return fail('a table row')
      const cells = list(row.props.children).map((cell) => {
        if (!isElement(cell) || (cell.type !== 'th' && cell.type !== 'td')) {
          return fail('a table cell')
        }
        const content =
          cell.props.children === undefined
            ? ''
            : render(cell.props.children, label).trim()
        return /[\n|]/.test(content) ? fail('a multi-line cell') : content
      })
      lines.push(`| ${cells.join(' | ')} |`)
      if (part.type === 'thead') {
        lines.push(`| ${cells.map(() => '---').join(' | ')} |`)
      }
    }
  }
  return lines
}

/**
 * The `## <heading>` section of a MiniMax pricing overview HTML page, as
 * MDX: the heading, then every element after it in the same parent up to
 * the next level-2 heading. Throws when the page has no compiled MDX body,
 * when the heading is not there exactly once, or when the section holds
 * an element or value `render` does not read.
 */
export function minimaxPricingSection(
  html: string,
  heading: string,
  label: string,
): string {
  const source = mdxModule(html, label)
  const fn = source.indexOf('function _createMdxContent(')
  const body = source.indexOf('return _jsx', fn)
  if (body < 0) throw new Error(`${label}: compiled MDX returns no element`)
  const tree = new MdxReader(source, body + 'return '.length, label).value()
  const parents = sectionsOf(tree, heading)
  const matches = parents.flatMap((parent) =>
    parent.filter((item) => isHeading(item, heading)),
  )
  const parent = parents[0]
  if (matches.length !== 1 || parent === undefined) {
    throw new Error(
      `${label}: ${String(matches.length)} "## ${heading}" headings, not one`,
    )
  }
  const start = parent.findIndex((item) => isHeading(item, heading)) + 1
  const end = parent.findIndex(
    (item, index) => index >= start && isHeading(item),
  )
  const section = parent.slice(start, end < 0 ? undefined : end)
  return `\n## ${heading}\n${render(section, label)}`
}
