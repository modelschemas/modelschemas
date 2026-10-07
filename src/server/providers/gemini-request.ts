/**
 * Gemini chat request map, read from the Generative Language discovery
 * document plus the thinking page's per-model budget numbers.
 * `generationConfig.maxOutputTokens` is published, and ChatRequestMap has
 * no field for it, so `maxTokensField` stays null.
 */
import type { GeminiBudgetBody } from './gemini-features.ts'
import { cachedDocs } from './model-facts.ts'
import type { ChatRequestMap, EffortLevelMap } from './request-map.ts'
import { SHARED_EFFORT_LEVELS } from './request-map.ts'
import type { FactSource, ModelReasoning } from './types.ts'
import { fetchText, sha256Text } from './types.ts'

export const GEMINI_DISCOVERY_URL =
  'https://generativelanguage.googleapis.com/$discovery/rest?version=v1beta'

interface DiscoveryProperty {
  description?: string
  enum?: Array<string>
}

interface DiscoverySchema {
  properties?: Record<string, DiscoveryProperty>
}

interface DiscoveryDoc {
  schemas?: Record<string, DiscoverySchema>
}

export interface GeminiWire {
  /** `ThinkingConfig.thinkingLevel` enum, without `THINKING_LEVEL_UNSPECIFIED`. */
  thinkingLevels: Array<string> | null
  hasThinkingBudget: boolean
  /** False when `Content.role` allows only `user` and `model`. */
  developerRole: false | null
}

const ROLE_IS_USER_OR_MODEL = /must be either 'user' or 'model'/i

export function parseGeminiWire(doc: DiscoveryDoc): GeminiWire {
  const thinking = doc.schemas?.ThinkingConfig?.properties
  const levels = thinking?.thinkingLevel?.enum?.filter(
    (value) => value !== 'THINKING_LEVEL_UNSPECIFIED',
  )
  const thinkingLevels = levels && levels.length > 0 ? levels : null
  const hasThinkingBudget = thinking?.thinkingBudget !== undefined
  const role = doc.schemas?.Content?.properties?.role?.description ?? ''
  const developerRole = ROLE_IS_USER_OR_MODEL.test(role) ? false : null
  if (!thinkingLevels && !hasThinkingBudget && developerRole === null) {
    throw new Error('gemini discovery: no request-map fields')
  }
  return { thinkingLevels, hasThinkingBudget, developerRole }
}

function effortLevels(
  efforts: Array<string>,
  enums: Array<string>,
): EffortLevelMap {
  const out = {} as EffortLevelMap
  for (const level of SHARED_EFFORT_LEVELS) {
    const wire = level.toUpperCase()
    out[level] =
      level !== 'off' && efforts.includes(level) && enums.includes(wire)
        ? wire
        : null
  }
  return out
}

function thinkingBody(
  field: 'thinkingLevel' | 'thinkingBudget',
  value: string | number,
): Record<string, unknown> {
  return { generationConfig: { thinkingConfig: { [field]: value } } }
}

/**
 * A non-null map needs a verified `developerRole` or a verified thinking
 * body. Effort `on` is `thinkingLevel: HIGH` from the discovery enum.
 * Budget `on` is the thinking page's dynamic `thinkingBudget` (Gemini
 * publishes -1 for dynamic, not an effort). `off` is only the disable
 * cell's number.
 */
export function geminiRequestMap(
  wire: GeminiWire,
  reasoning: ModelReasoning | null,
  budget: GeminiBudgetBody | null,
): ChatRequestMap | null {
  let thinking: ChatRequestMap['thinking'] = null
  if (
    reasoning?.mode === 'effort' &&
    reasoning.efforts?.includes('high') &&
    wire.thinkingLevels?.includes('HIGH')
  ) {
    thinking = {
      on: thinkingBody('thinkingLevel', 'HIGH'),
      off: null,
      levels: effortLevels(reasoning.efforts, wire.thinkingLevels),
    }
  } else if (
    reasoning?.mode === 'budget' &&
    budget !== null &&
    wire.hasThinkingBudget
  ) {
    thinking = {
      on: thinkingBody('thinkingBudget', budget.on),
      off:
        budget.off === null ? null : thinkingBody('thinkingBudget', budget.off),
      levels: null,
    }
  }
  if (wire.developerRole === null && thinking === null) return null
  return {
    thinking,
    maxTokensField: null,
    developerRole: wire.developerRole,
    replayReasoningContent: null,
    store: null,
    strictTools: null,
    sessionAffinity: null,
    cacheControl: null,
    toolStream: null,
    reasoningEffort: null,
  }
}

export async function geminiWire(kv?: KVNamespace): Promise<{
  fields: GeminiWire
  source: FactSource
}> {
  const loaded = await cachedDocs(kv, GEMINI_DISCOVERY_URL, async () => {
    const text = await fetchText(GEMINI_DISCOVERY_URL)
    const parsed: unknown = JSON.parse(text)
    const doc =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as DiscoveryDoc)
        : {}
    return { fields: parseGeminiWire(doc), hash: await sha256Text(text) }
  })
  return {
    fields: loaded.fields,
    source: {
      derivation: 'docs-derived',
      sourceUrl: GEMINI_DISCOVERY_URL,
      sourceHash: loaded.hash,
      path: 'GenerateContentRequest',
    },
  }
}
