/**
 * Bracket scanning over a docs page's compiled MDX, where every string is a
 * template literal with no `${…}` (`_jsx(Component,{key:`value`,…})`).
 * Shared by readers of pages whose `.md` export renders a component
 * without its values (Kimi `<DocTable>`, Cerebras `<ModelInfo>`, MiniMax
 * `<Tab>` or without its nesting (Novita `<ParamField>`).

 */

/** Index of the backtick closing the template literal opened at `open`. */
export function literalEnd(
  source: string,
  open: number,
  label: string,
): number {
  for (let i = open + 1; i < source.length; i++) {
    if (source[i] === '\\') i++
    else if (source[i] === '`') return i
  }
  throw new Error(`${label}: unterminated template literal`)
}

/** Index of the bracket closing the one at `open`, skipping literals. */
export function closing(source: string, open: number, label: string): number {
  let depth = 0
  for (let i = open; i < source.length; i++) {
    const char = source[i]
    if (char === '`') {
      i = literalEnd(source, i, label)
    } else if (char === '[' || char === '{' || char === '(') {
      depth++
    } else if (char === ']' || char === '}' || char === ')') {
      depth--
      if (depth === 0) return i
    }
  }
  throw new Error(`${label}: unbalanced brackets`)
}
