import { stripFences } from './model-facts.ts'
import type { ThinkingRequest } from './request-map.ts'

/** Gateway effort names come from normative provider documentation, never examples. */
export const OPENROUTER_REASONING_URL =
  'https://openrouter.ai/docs/guides/best-practices/reasoning-tokens.md'
export function openRouterGatewayEfforts(markdown: string): Array<string> {
  const prose = stripFences(markdown)
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

/** Messages compatibility is explicitly normalized for every reasoning model. */
export function openRouterGatewayToggle(markdown: string): ThinkingRequest {
  const prose = stripFences(markdown)
  const section = prose
    .split(/^## Reasoning with the Anthropic Messages API\s*$/m)[1]
    ?.split(/^#{1,2} /m)[0]
  if (
    !section ||
    !/^Requests sent through[^\n]*OpenRouter normalizes both into the unified `reasoning` parameter, so they work on every reasoning model, not only Claude\./m.test(
      section,
    )
  )
    throw new Error('openrouter: native gateway toggle scope missing')
  if (
    !/^\| `thinking: \{ type: "adaptive" \}` \| `reasoning: \{ enabled: true \}` \|$/m.test(
      section,
    ) ||
    !/^\| `thinking: \{ type: "disabled" \}` \| `reasoning: \{ enabled: false \}` \|$/m.test(
      section,
    ) ||
    !/^`thinking: \{ type: "disabled" \}` disables reasoning even when an `output_config\.effort` is also present\./m.test(
      section,
    )
  )
    throw new Error(
      'openrouter: native gateway enable/disable contract missing',
    )
  const body = (type: 'adaptive' | 'disabled') => {
    const row = section
      .split('\n')
      .find((line) => line.startsWith(`| \`thinking: { type: "${type}" }\``))
    const wire = row?.match(/\| `([a-z_]+): \{ ([a-z_]+): (true|false) \}` \|$/)
    if (!wire?.[1] || !wire[2] || !wire[3])
      throw new Error('openrouter: native toggle wire map unreadable')
    return { [wire[1]]: { [wire[2]]: wire[3] === 'true' } }
  }
  return { on: body('adaptive'), off: body('disabled'), levels: null }
}

/** Read actual canonical effort wire fields from the native normalization table. */
export function openRouterGatewayEffortWire(markdown: string): {
  outer: string
  field: string
} {
  const prose = stripFences(markdown)
  const section = prose
    .split(/^## Reasoning with the Anthropic Messages API\s*$/m)[1]
    ?.split(/^#{1,2} /m)[0]
  if (
    !section ||
    !/^Requests sent through[^\n]*OpenRouter normalizes both into the unified `reasoning` parameter, so they work on every reasoning model, not only Claude\./m.test(
      section,
    )
  )
    throw new Error('openrouter: native effort wire scope missing')
  const row = section.match(
    /^\| `output_config: \{ effort \}` \| `([a-z_]+): \{ ([a-z_]+) \}` \|$/m,
  )
  if (!row?.[1] || !row[2])
    throw new Error('openrouter: native effort wire fields missing')
  return { outer: row[1], field: row[2] }
}

const OPENROUTER_MIGRATIONS =
  'https://openrouter.ai/docs/cookbook/evaluate-and-optimize/model-migrations/'

// ponytail: hand-written from OpenRouter's Claude migration guides on
// 2026-10-15. Each guide names its models in prose; each row's `states`
// sentence is re-checked whenever its guide is fetched. Add a row when
// OpenRouter publishes a guide for a new Claude model.
export const OPENROUTER_ADAPTIVE_GUIDES = [
  {
    url: `${OPENROUTER_MIGRATIONS}claude-4-6.md`,
    ids: ['anthropic/claude-opus-4.6', 'anthropic/claude-sonnet-4.6'],
    states:
      /^For Claude 4\.6 Opus and 4\.6 Sonnet, OpenRouter now uses adaptive thinking \(`thinking\.type: 'adaptive'`\) by default/m,
  },
  {
    url: `${OPENROUTER_MIGRATIONS}claude-4-7.md`,
    ids: ['anthropic/claude-opus-4.7'],
    states: /^Claude 4\.7 Opus supports only adaptive thinking\./m,
  },
  {
    url: `${OPENROUTER_MIGRATIONS}sonnet-5.md`,
    ids: ['anthropic/claude-sonnet-5'],
    states: /^Claude 5 Sonnet supports only adaptive thinking\./m,
  },
  {
    url: `${OPENROUTER_MIGRATIONS}opus-5.md`,
    ids: ['anthropic/claude-opus-5'],
    states: /^Like Sonnet 5, Opus 5 supports only adaptive thinking/m,
  },
  {
    url: `${OPENROUTER_MIGRATIONS}claude-5-5.md`,
    ids: [
      'anthropic/claude-opus-5.5',
      'anthropic/claude-sonnet-5.5',
      'anthropic/claude-haiku-5.5',
    ],
    states:
      /^All three models share these changes:\s*1\. \*\*Adaptive thinking runs by default\.\*\*/m,
  },
]

/** The guide for an OpenRouter id; a `:variant` suffix serves the same model. */
export function openRouterAdaptiveGuide(rawId: string) {
  const base = rawId.replace(/:.*/, '')
  return OPENROUTER_ADAPTIVE_GUIDES.find((guide) => guide.ids.includes(base))
}

/** True while the guide prose still states adaptive thinking. */
export function statesAdaptive(
  markdown: string,
  guide: { states: RegExp },
): boolean {
  return guide.states.test(stripFences(markdown))
}
