/**
 * Selection grammar (PLAN.md task 12.3):
 *
 *   provider[/endpointPattern][#request|#response]
 *
 * `endpointPattern` may contain `*` globs and is matched against public
 * endpoint ids (which themselves contain slashes, e.g. `v1/messages`).
 * Omitting the pattern selects every endpoint; omitting the kind selects
 * both — implicitly, so a missing side (e.g. an endpoint with no response
 * schema) is skipped rather than an error.
 */

export type Kind = 'input' | 'output'
export type KindLabel = 'request' | 'response'

export const KIND_LABEL: Record<Kind, KindLabel> = {
  input: 'request',
  output: 'response',
}
export const LABEL_KIND: Record<KindLabel, Kind> = {
  request: 'input',
  response: 'output',
}

export interface ParsedSelection {
  provider: string
  /** Glob over public endpoint ids; `*` when the selection names none. */
  endpointPattern: string
  kinds: Array<Kind>
  /** True when the selection pinned a kind with `#request`/`#response`. */
  explicitKind: boolean
  raw: string
}

export function parseSelection(raw: string): ParsedSelection {
  const trimmed = raw.trim()
  if (trimmed === '') throw new Error('Empty selection.')

  const hashIndex = trimmed.indexOf('#')
  const body = hashIndex === -1 ? trimmed : trimmed.slice(0, hashIndex)
  const kindLabel = hashIndex === -1 ? undefined : trimmed.slice(hashIndex + 1)
  if (kindLabel?.includes('#') === true) {
    throw new Error(`Selection '${raw}': more than one '#'.`)
  }
  let kinds: Array<Kind> = ['input', 'output']
  if (kindLabel !== undefined) {
    if (kindLabel !== 'request' && kindLabel !== 'response') {
      throw new Error(
        `Selection '${raw}': unknown kind '#${kindLabel}'. Use #request or #response.`,
      )
    }
    kinds = [LABEL_KIND[kindLabel]]
  }

  const slash = body.indexOf('/')
  const provider = slash === -1 ? body : body.slice(0, slash)
  const endpointPattern = slash === -1 ? '*' : body.slice(slash + 1)
  if (provider === '') throw new Error(`Selection '${raw}': empty provider.`)
  if (provider.includes('*')) {
    throw new Error(
      `Selection '${raw}': globs are only supported in the endpoint part — name a provider (GET /v1/providers lists them).`,
    )
  }
  if (endpointPattern === '') {
    throw new Error(`Selection '${raw}': empty endpoint pattern after '/'.`)
  }

  return {
    provider,
    endpointPattern,
    kinds,
    explicitKind: kindLabel !== undefined,
    raw: trimmed,
  }
}

export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${escaped}$`)
}

export interface ResolvedTarget {
  provider: string
  activity: string
  endpointId: string
  kind: Kind
  explicitKind: boolean
  /** The selection string that produced this target. */
  selector: string
}

/** The `/v1/schemas/{provider}` index shape this package consumes. */
export interface ProviderSchemaIndex {
  provider: string
  activities: Record<string, Array<string>>
}

/**
 * Expand one parsed selection against a provider's schema index. Throws
 * when a concrete (glob-free) pattern matches nothing — that's a typo, and
 * the error lists valid ids; an unmatched glob just returns [].
 */
export function matchTargets(
  selection: ParsedSelection,
  index: ProviderSchemaIndex,
): Array<ResolvedTarget> {
  const pattern = globToRegExp(selection.endpointPattern)
  const targets: Array<ResolvedTarget> = []
  for (const [activity, endpointIds] of Object.entries(index.activities)) {
    for (const endpointId of endpointIds) {
      if (!pattern.test(endpointId)) continue
      for (const kind of selection.kinds) {
        targets.push({
          provider: selection.provider,
          activity,
          endpointId,
          kind,
          explicitKind: selection.explicitKind,
          selector: selection.raw,
        })
      }
    }
  }
  if (targets.length === 0 && !selection.endpointPattern.includes('*')) {
    const valid = Object.values(index.activities).flat().slice(0, 25)
    throw new Error(
      `Selection '${selection.raw}': no endpoint '${selection.endpointPattern}' for provider '${selection.provider}'.` +
        (valid.length > 0 ? ` Valid endpoint ids: ${valid.join(', ')}.` : ''),
    )
  }
  return targets
}
