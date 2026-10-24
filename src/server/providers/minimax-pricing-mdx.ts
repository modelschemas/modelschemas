/**
 * The price section of a MiniMax pricing overview, read from the HTML page.
 * The `.md` export (#379) and, since 2026-10-21, `llms-full.txt` (#399)
 * render each `<Tab>` title as a bold line and drop the struck list price
 * and its badge, which leaves no way to tell the tiers apart or a standing
 * price from a promotion. The HTML page's RSC payload still embeds the
 * compiled MDX: `self.__next_f.push([1,"…"])`, a JSON string holding the
 * module source, whose `_createMdxContent` returns a JSX tree: values are
 * template literals with no `${…}`, and a key that is not an identifier is
 * a double-quoted string.
 *
 * This parses that tree and renders the `## <heading>` section back to the
 * MDX `parseMinimaxPricing` reads: tabs, accordions, callouts, and headings
 * as themselves, tables as `|` rows, `del` as `~~`, a badge `<span>` with
 * its class. An element it does not know, a prop or prop value it does not
 * know (a style or class can strike or hide a price), a block inside inline
 * content, or a value it cannot read throws: nothing is guessed about a
 * component it has not seen.
 */
import { asText } from '#/lib/text.ts'
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
    const near = JSON.stringify(this.source.slice(this.at, this.at + 40))
    throw new Error(
      `${this.label}: ${what} in the compiled MDX at ${String(this.at)} (${near})`,
    )
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
  try {
    return JSON.parse(html.slice(open, close + 1)) as string
  } catch (error) {
    throw new Error(`${label}: RSC payload string does not parse`, {
      cause: error,
    })
  }
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

/** Elements that open a block: never read inside a cell, a line, or a run of text. */
const BLOCKS = new Set([
  'p',
  'ol',
  'ul',
  'Table',
  'Tabs',
  'Tab',
  'Accordion',
  'Heading',
  ...CALLOUTS,
])

/** A prop check: the prop's value is one this renderer knows the meaning of. */
type PropCheck = (value: MdxValue) => boolean

const anyText: PropCheck = (value) =>
  typeof value === 'string' && !/["\n]/.test(value)
/** `style:{key:`value`}` with exactly these keys, each value allowed. */
const style =
  (allowed: Record<string, RegExp>): PropCheck =>
  (value) =>
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    value.kind === 'object' &&
    Object.entries(value.props).every(([key, prop]) => {
      const pattern = allowed[key]
      return (
        pattern !== undefined && typeof prop === 'string' && pattern.test(prop)
      )
    })

/**
 * The props each element may carry beside `children`. Any other prop, or
 * a known one with a value not listed, throws: a style or class can strike
 * or hide what the text alone would show as a billed price.
 */
const PROPS: Record<string, Record<string, PropCheck>> = {
  _Fragment: {},
  p: {},
  strong: {},
  em: {},
  del: {},
  code: {},
  br: {},
  ol: {},
  ul: {},
  li: {},
  a: { href: anyText },
  Tabs: {},
  Tab: { title: anyText, id: anyText },
  Accordion: { title: anyText, id: anyText },
  Heading: {
    level: (value) => typeof value === 'string' && /^[1-6]$/.test(value),
    id: anyText,
  },
  Table: {},
  thead: {},
  tbody: {},
  tr: {},
  th: { style: style({ textAlign: /^(?:left|center|right)$/ }) },
  td: {
    style: style({ textAlign: /^(?:left|center|right)$/ }),
    'data-numeric': (value) => value === 'true',
  },
  ...Object.fromEntries([...CALLOUTS].map((type) => [type, {}])),
}

/** Throws unless every prop of `element` is one `PROPS` allows for its type. */
function checkProps(element: MdxElement, label: string): void {
  const allowed = PROPS[element.type]
  if (allowed === undefined) {
    throw new Error(
      `${label}: <${element.type}> in the price section is not read`,
    )
  }
  for (const [key, value] of Object.entries(element.props)) {
    if (key === 'children') continue
    const check = allowed[key]
    if (check === undefined || !check(value)) {
      throw new Error(
        `${label}: <${element.type}> ${key} in the price section is not read`,
      )
    }
  }
}

/**
 * The MDX for one value of the section; throws on what it does not read.
 * `inline` is true inside a cell, a paragraph, a list item, or inline
 * markup, where a block element would be flattened into the wrong place.
 */
function render(value: MdxValue, label: string, inline = false): string {
  const fail = (what: string): never => {
    throw new Error(`${label}: ${what} in the price section is not read`)
  }
  // `~~` is the parser's strike and `<span` its badge: text that could
  // spell either is not read.
  if (typeof value === 'string') {
    return /[~<]/.test(value)
      ? fail('a `~` or `<` in text')
      : value.replace(/\*/g, '\\*')
  }
  if (Array.isArray(value)) {
    return value.map((item) => render(item, label, inline)).join('')
  }
  if (!isElement(value)) return fail(`a ${typeof value} value`)
  const { type, props } = value
  if (type === 'span') {
    // A `white-space: nowrap` span is layout; a span with only a class is
    // a badge, kept so the parser can read its text.
    const keys = Object.keys(props).filter((key) => key !== 'children')
    const content = render(props.children ?? '', label, true)
    if (
      keys.join() === 'style' &&
      style({ whiteSpace: /^nowrap$/ })(props.style ?? null)
    ) {
      return content
    }
    if (keys.join() === 'className' && anyText(props.className ?? null)) {
      return `<span className="${asText(props.className)}">${content}</span>`
    }
    return fail('<span> props')
  }
  checkProps(value, label)
  if (inline && BLOCKS.has(type)) return fail(`<${type}> inside inline content`)
  const children = (asInline: boolean) =>
    props.children === undefined ? '' : render(props.children, label, asInline)
  const prop = (key: string) => asText(props[key])
  switch (type) {
    case '_Fragment':
      return children(inline)
    case 'p':
      return `\n\n${children(true)}\n\n`
    case 'a':
      return `[${children(true)}](${prop('href')})`
    case 'strong':
      return `**${children(true)}**`
    case 'em':
      return `*${children(true)}*`
    case 'del':
      return `~~${children(true)}~~`
    case 'code':
      return `\`${children(true)}\``
    case 'br':
      return '<br />'
    case 'ol':
    case 'ul':
      return `\n\n${children(false)}\n\n`
    case 'li':
      return `\n- ${children(true)}`
    case 'Table':
      return `\n\n${table(value, label).join('\n')}\n\n`
    case 'Tabs':
      return `\n\n<Tabs>\n${children(false)}\n</Tabs>\n\n`
    case 'Tab':
      return `\n<Tab title="${prop('title')}">\n${children(false)}\n</Tab>\n`
    case 'Accordion':
      return `\n\n<Accordion title="${prop('title')}">\n${children(false)}\n</Accordion>\n\n`
    case 'Heading':
      return `\n\n${'#'.repeat(Number(prop('level')))} ${children(true)}\n\n`
    default:
      // A callout: `checkProps` admits no other type.
      return `\n\n<${type}>\n${children(false)}\n</${type}>\n\n`
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
    checkProps(part, label)
    for (const row of list(part.props.children)) {
      if (!isElement(row, 'tr')) return fail('a table row')
      checkProps(row, label)
      const cells = list(row.props.children).map((cell) => {
        if (!isElement(cell) || (cell.type !== 'th' && cell.type !== 'td')) {
          return fail('a table cell')
        }
        checkProps(cell, label)
        const content =
          cell.props.children === undefined
            ? ''
            : render(cell.props.children, label, true).trim()
        if (content.includes('|')) return fail('a `|` in a cell')
        return content.includes('\n') ? fail('a multi-line cell') : content
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
