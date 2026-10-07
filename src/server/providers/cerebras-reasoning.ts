/**
 * Reasoning controls and the chat request map, read on every poll.
 *
 * The reasoning table
 * (https://inference-docs.cerebras.ai/capabilities/reasoning.md) names each
 * model's `reasoning_effort` values and whether reasoning can be disabled.
 * A value list is effort mode. "Accepted but ignored" is not a control.
 *
 * The chat spec
 * (https://inference-docs.cerebras.ai/api-reference/openapi.yaml) names
 * `max_completion_tokens` (`max_tokens` is its alias) and says developer
 * messages are supported only by the ids in that sentence.
 */
import { assertParsed, cachedDocs, markdownTableRows } from './model-facts.ts'
import { reasoningFactsFor } from './reasoning-config.ts'
import type { ChatRequestMap, EffortLevelMap } from './request-map.ts'
import { fetchText, sha256Text } from './types.ts'
import type { ModelInfo, ModelReasoning } from './types.ts'

export const CEREBRAS_REASONING_URL =
  'https://inference-docs.cerebras.ai/capabilities/reasoning.md'
export const CEREBRAS_CHAT_SPEC_URL =
  'https://inference-docs.cerebras.ai/api-reference/openapi.yaml'

export interface CerebrasReasoningDoc {
  configured: Map<string, ModelReasoning>
  /** Accepts `reasoning_effort` and ignores it. No reasoning object. */
  ignored: Array<string>
}

export interface CerebrasChatSpec {
  maxTokensField: 'max_completion_tokens' | 'max_tokens'
  /** Ids the spec says may send `role: "developer"`. */
  developerIds: Array<string>
}

function column(
  header: Array<string>,
  cells: Array<string>,
  name: string,
): string {
  const index = header.findIndex((cell) =>
    cell.toLowerCase().includes(name.toLowerCase()),
  )
  return index < 0 ? '' : (cells[index] ?? '')
}

function modelId(cell: string): string {
  const id = cell.match(/`([a-z0-9][a-z0-9.-]*)`/)?.[1]
  if (!id) throw new Error(`cerebras reasoning: model cell has no id: ${cell}`)
  return id
}

/** `true` when the cell says reasoning cannot be disabled. */
function mandatoryFrom(cell: string): boolean {
  const notSupported = /not supported/i.test(cell)
  const canDisable = /set `reasoning_effort` to `none`/i.test(cell)
  if (notSupported === canDisable) {
    throw new Error(`cerebras reasoning: unread disable cell: ${cell}`)
  }
  return notSupported
}

function effortValues(cell: string): Array<string> | 'ignored' {
  if (/accepted but ignored/i.test(cell)) {
    if (/`[^`]+`/.test(cell)) {
      throw new Error(
        `cerebras reasoning: ignored effort cell also lists values: ${cell}`,
      )
    }
    return 'ignored'
  }
  const values = [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? '')
  if (values.length === 0 || values.some((value) => value === '')) {
    throw new Error(`cerebras reasoning: unread effort cell: ${cell}`)
  }
  return values
}

/** The first reasoning table. Any other disable or effort wording throws. */
export function parseCerebrasReasoning(markdown: string): CerebrasReasoningDoc {
  const configured = new Map<string, ModelReasoning>()
  const ignored: Array<string> = []
  let header: Array<string> | null = null
  for (const cells of markdownTableRows(markdown)) {
    if (
      cells[0] === 'Model' &&
      cells.some((cell) => cell.includes('reasoning_effort'))
    ) {
      if (!cells.some((cell) => /disable reasoning/i.test(cell))) {
        throw new Error(
          'cerebras reasoning: table has no Disable reasoning column',
        )
      }
      header = cells
      continue
    }
    if (!header || cells.length !== header.length) continue
    const id = modelId(column(header, cells, 'Model'))
    if (configured.has(id) || ignored.includes(id)) {
      throw new Error(`cerebras reasoning: duplicate id ${id}`)
    }
    const efforts = effortValues(column(header, cells, 'reasoning_effort'))
    if (efforts === 'ignored') {
      ignored.push(id)
      continue
    }
    const mandatory = mandatoryFrom(column(header, cells, 'Disable reasoning'))
    if (mandatory && efforts.includes('none')) {
      throw new Error(
        `cerebras reasoning: ${id} cannot be disabled but lists none`,
      )
    }
    if (!mandatory && !efforts.includes('none')) {
      throw new Error(
        `cerebras reasoning: ${id} can be disabled but lists no none`,
      )
    }
    configured.set(id, { mode: 'effort', mandatory, efforts })
  }
  if (!header) throw new Error('cerebras reasoning: no reasoning_effort table')
  return { configured, ignored }
}

function property(yaml: string, name: string): boolean {
  return new RegExp(`^[ \\t]+${name}:[ \\t]*$`, 'm').test(yaml)
}

/**
 * Output-cap field and the models allowed to send `developer`. Throws when
 * the spec no longer says which field is the alias, or which models take
 * the developer role.
 */
export function parseCerebrasChatSpec(yaml: string): CerebrasChatSpec {
  const completion = property(yaml, 'max_completion_tokens')
  const alias = property(yaml, 'max_tokens')
  if (!completion && !alias) {
    throw new Error('cerebras spec: no max token field')
  }
  if (alias) {
    const aliasOf =
      /max_tokens:[\s\S]{0,400}?An alias for `max_completion_tokens`/.test(yaml)
    if (!aliasOf) {
      throw new Error(
        'cerebras spec: max_tokens is not an alias of max_completion_tokens',
      )
    }
  }
  if (!completion) {
    return { maxTokensField: 'max_tokens', developerIds: developerIds(yaml) }
  }
  return {
    maxTokensField: 'max_completion_tokens',
    developerIds: developerIds(yaml),
  }
}

function developerIds(yaml: string): Array<string> {
  const sentence = yaml.match(
    /Developer messages are supported only by ([^.]+)\./,
  )?.[1]
  if (!sentence) {
    throw new Error('cerebras spec: developer-role sentence missing')
  }
  const ids = [...sentence.matchAll(/`([^`]+)`/g)].map(
    (match) => match[1] ?? '',
  )
  if (ids.length === 0 || ids.some((id) => id === '')) {
    throw new Error('cerebras spec: developer-role sentence names no model')
  }
  return ids
}

function levelsFor(efforts: Array<string>, off: string | null): EffortLevelMap {
  return {
    off,
    minimal: efforts.includes('minimal') ? 'minimal' : null,
    low: efforts.includes('low') ? 'low' : null,
    medium: efforts.includes('medium') ? 'medium' : null,
    high: efforts.includes('high') ? 'high' : null,
    xhigh: efforts.includes('xhigh') ? 'xhigh' : null,
    max: efforts.includes('max') ? 'max' : null,
  }
}

/** `on` is effort high. A model that does not accept `high` has no such body. */
export function cerebrasThinking(
  efforts: Array<string>,
): ChatRequestMap['thinking'] {
  if (!efforts.includes('high')) return null
  const off = efforts.includes('none') ? 'none' : null
  return {
    on: { reasoning_effort: 'high' },
    off: off === null ? null : { reasoning_effort: off },
    levels: levelsFor(efforts, off),
  }
}

export function cerebrasRequestMap(
  rawId: string,
  spec: CerebrasChatSpec,
  reasoning: ModelReasoning | undefined,
  ignored: boolean,
): ChatRequestMap {
  const efforts =
    reasoning?.mode === 'effort' ? (reasoning.efforts ?? []) : null
  return {
    thinking: efforts ? cerebrasThinking(efforts) : null,
    maxTokensField: spec.maxTokensField,
    developerRole: spec.developerIds.includes(rawId),
    replayReasoningContent: null,
    store: null,
    strictTools: null,
    sessionAffinity: null,
    cacheControl: null,
    toolStream: null,
    reasoningEffort: efforts !== null || ignored ? true : null,
  }
}

interface CachedReasoning {
  byId: Record<string, ModelReasoning>
  ignored: Array<string>
  hash: string
}

interface CachedSpec {
  spec: CerebrasChatSpec
  hash: string
}

/** Reasoning object plus the request map for one listed id. */
export async function cerebrasChatFacts(
  kv?: KVNamespace,
): Promise<(rawId: string, capability: boolean) => Partial<ModelInfo>> {
  const [reasoning, spec] = await Promise.all([
    cachedDocs(kv, CEREBRAS_REASONING_URL, async () => {
      const markdown = await fetchText(CEREBRAS_REASONING_URL)
      const parsed = parseCerebrasReasoning(markdown)
      assertParsed(parsed.configured, 'cerebras reasoning')
      const cached: CachedReasoning = {
        byId: Object.fromEntries(parsed.configured),
        ignored: parsed.ignored,
        hash: await sha256Text(markdown),
      }
      return cached
    }),
    cachedDocs(kv, CEREBRAS_CHAT_SPEC_URL, async () => {
      const yaml = await fetchText(CEREBRAS_CHAT_SPEC_URL)
      const cached: CachedSpec = {
        spec: parseCerebrasChatSpec(yaml),
        hash: await sha256Text(yaml),
      }
      return cached
    }),
  ])
  return (rawId, capability) => {
    const row = reasoning.byId[rawId]
    return {
      ...reasoningFactsFor(
        rawId,
        reasoning.byId,
        { url: CEREBRAS_REASONING_URL, hash: reasoning.hash },
        capability,
      ),
      requestMap: cerebrasRequestMap(
        rawId,
        spec.spec,
        row,
        reasoning.ignored.includes(rawId),
      ),
    }
  }
}
