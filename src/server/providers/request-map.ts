/**
 * How a caller turns a shared chat intent into one provider's request body
 * (issue #95). `reasoning` stays the readable fact. This object is the wire
 * map. Unverified providers and non-chat rows are null — no guessed body.
 * Unverified flags inside a verified map are null, not a default.
 */

export const SHARED_EFFORT_LEVELS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const

export type SharedEffortLevel = (typeof SHARED_EFFORT_LEVELS)[number]

/** Value this model accepts for a shared level. null means omit the field. */
export type EffortLevelMap = Record<SharedEffortLevel, string | null>

export interface ThinkingRequest {
  /** Request body for "thinking on, effort high". */
  on: Record<string, unknown>
  /** Explicit off, when silence would make the model think. */
  off: Record<string, unknown> | null
  /** Shared levels → the value this model accepts. null when unverified. */
  levels: EffortLevelMap | null
}

export interface ChatRequestMap {
  thinking: ThinkingRequest | null
  maxTokensField: 'max_completion_tokens' | 'max_tokens' | null
  /** True when the model wants `role: "developer"`; false when it rejects it. */
  developerRole: boolean | null
  replayReasoningContent: boolean | null
  store: boolean | null
  strictTools: boolean | null
  sessionAffinity: boolean | null
  cacheControl: 'anthropic' | null
  toolStream: boolean | null
  /** False when the provider rejects a top-level `reasoning_effort` field. */
  reasoningEffort: boolean | null
}

const OPENAI_ON = { reasoning_effort: 'high' }
const DEEPSEEK_ON = {
  thinking: { type: 'enabled' },
  reasoning_effort: 'high',
}
const DEEPSEEK_OFF = { thinking: { type: 'disabled' } }
const GLM_ON = { thinking: { type: 'enabled', clear_thinking: false } }
const QWEN_ON = { enable_thinking: true }
const VLLM_QWEN_ON = {
  chat_template_kwargs: { enable_thinking: true, preserve_thinking: true },
}
const OPENROUTER_ON = { reasoning: { effort: 'high' } }
const TOGETHER_ON = { reasoning: { enabled: true } }

/** `openai/gpt-5.1`: off is sent as "none"; minimal, xhigh, and max are omitted. */
const GPT_51_LEVELS: EffortLevelMap = {
  off: 'none',
  minimal: null,
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: null,
  max: null,
}

/** `deepseek/deepseek-flash`: only low, high, and max. medium is omitted. */
const DEEPSEEK_FLASH_LEVELS: EffortLevelMap = {
  off: null,
  minimal: null,
  low: 'low',
  medium: null,
  high: 'high',
  xhigh: null,
  max: 'max',
}

/** `zai/glm-5.2`: only high and max. */
const GLM_52_LEVELS: EffortLevelMap = {
  off: null,
  minimal: null,
  low: null,
  medium: null,
  high: 'high',
  xhigh: null,
  max: 'max',
}

function blank(partial: Partial<ChatRequestMap>): ChatRequestMap {
  return {
    thinking: null,
    maxTokensField: null,
    developerRole: null,
    replayReasoningContent: null,
    store: null,
    strictTools: null,
    sessionAffinity: null,
    cacheControl: null,
    toolStream: null,
    reasoningEffort: null,
    ...partial,
  }
}

function bareId(rawId: string): string {
  const slash = rawId.lastIndexOf('/')
  return slash === -1 ? rawId : rawId.slice(slash + 1)
}

function matches(rawId: string, name: string): boolean {
  const bare = bareId(rawId)
  return bare === name || bare.startsWith(`${name}-`)
}

function levelsFor(rawId: string): EffortLevelMap | null {
  if (matches(rawId, 'gpt-5.1')) return GPT_51_LEVELS
  if (matches(rawId, 'deepseek-flash')) return DEEPSEEK_FLASH_LEVELS
  if (matches(rawId, 'glm-5.2')) return GLM_52_LEVELS
  return null
}

function withLevels(thinking: ThinkingRequest, rawId: string): ThinkingRequest {
  const levels = levelsFor(rawId)
  return levels === null ? thinking : { ...thinking, levels }
}

/**
 * Provider-wide request facts for one chat model. Model-specific level maps
 * override the provider's `thinking.levels`. Anything not verified stays null.
 */
export function chatRequestMap(
  providerId: string,
  rawId: string,
  activity: string | null | undefined,
): ChatRequestMap | null {
  if (activity !== 'chat') return null
  switch (providerId) {
    case 'openai':
      return blank({
        thinking: withLevels({ on: OPENAI_ON, off: null, levels: null }, rawId),
        maxTokensField: 'max_completion_tokens',
        developerRole: true,
        reasoningEffort: true,
      })
    case 'deepseek':
      return blank({
        thinking: withLevels(
          { on: DEEPSEEK_ON, off: DEEPSEEK_OFF, levels: null },
          rawId,
        ),
        maxTokensField: 'max_tokens',
        developerRole: false,
        replayReasoningContent: true,
        reasoningEffort: true,
      })
    case 'zai':
    case 'glm':
      return blank({
        thinking: withLevels({ on: GLM_ON, off: null, levels: null }, rawId),
        maxTokensField: 'max_tokens',
        developerRole: false,
        toolStream: true,
        reasoningEffort: false,
      })
    case 'qwen':
      return blank({
        thinking: withLevels({ on: QWEN_ON, off: null, levels: null }, rawId),
        developerRole: false,
      })
    case 'vllm':
      return blank({
        thinking: withLevels(
          { on: VLLM_QWEN_ON, off: null, levels: null },
          rawId,
        ),
        developerRole: false,
      })
    case 'openrouter':
      return blank({
        thinking: withLevels(
          { on: OPENROUTER_ON, off: null, levels: null },
          rawId,
        ),
        sessionAffinity: true,
        cacheControl: rawId.startsWith('anthropic/') ? 'anthropic' : null,
      })
    case 'together':
      return blank({
        thinking: withLevels(
          { on: TOGETHER_ON, off: null, levels: null },
          rawId,
        ),
        maxTokensField: 'max_tokens',
        developerRole: false,
        reasoningEffort: false,
      })
    case 'moonshot':
    case 'nvidia':
    case 'cloudflare':
      return blank({
        maxTokensField: 'max_tokens',
        developerRole: false,
        reasoningEffort: false,
      })
    case 'grok':
      return blank({
        developerRole: false,
        reasoningEffort: false,
      })
    default:
      return null
  }
}
