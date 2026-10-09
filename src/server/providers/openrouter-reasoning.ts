/** Gateway effort names come from normative provider documentation, never examples. */
export const OPENROUTER_REASONING_URL =
  'https://openrouter.ai/docs/guides/best-practices/reasoning-tokens.md'
export function openRouterGatewayEfforts(markdown: string): Array<string> {
  const prose = markdown.replace(/```[\s\S]*?```/g, '')
  if (!/When `null`, all gateway effort values are accepted/.test(prose))
    throw new Error('openrouter: native null-efforts contract missing')
  if (
    !/\*\*`mandatory`\*\*:[^\n]*When `true`[^\n]*do not send `effort: "none"`[^\n]*model rejects it/.test(
      prose,
    )
  )
    throw new Error('openrouter: native mandatory effort rejection missing')
  const values = [...prose.matchAll(/^\* `"effort": "([a-z]+)"` - .+$/gm)].map(
    (match) => match[1]!,
  )
  if (!values.length || new Set(values).size !== values.length)
    throw new Error(
      'openrouter: missing or ambiguous normative gateway efforts',
    )
  return values
}
