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
const KIMI_ON = { thinking: { type: 'enabled' } }
const KIMI_OFF = { thinking: { type: 'disabled' } }
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

/**
 * Moonshot's per-model chat schemas, by exact id: `kimi-k3` takes
 * `reasoning_effort` and always thinks, `kimi-k2.7-code` takes only
 * `thinking.type: enabled`, `kimi-k2.6` also takes `disabled`. An id the
 * spec does not map stays null.
 */
function kimiThinking(rawId: string): ThinkingRequest | null {
  switch (rawId) {
    case 'kimi-k3':
      return { on: OPENAI_ON, off: null, levels: KIMI_K3_LEVELS }
    case 'kimi-k2.7-code':
    case 'kimi-k2.7-code-highspeed':
      return { on: KIMI_ON, off: null, levels: null }
    case 'kimi-k2.6':
      return { on: KIMI_ON, off: KIMI_OFF, levels: null }
    default:
      return null
  }
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

/** `kimi-k3`: the spec's `reasoning_effort` enum. It cannot stop thinking. */
const KIMI_K3_LEVELS: EffortLevelMap = {
  off: null,
  minimal: null,
  low: 'low',
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

function levelsFor(providerId: string, rawId: string): EffortLevelMap | null {
  if (providerId === 'openai' && matches(rawId, 'gpt-5.1')) return GPT_51_LEVELS
  if (providerId === 'deepseek' && matches(rawId, 'deepseek-flash')) {
    return DEEPSEEK_FLASH_LEVELS
  }
  if (
    (providerId === 'zai' || providerId === 'glm') &&
    matches(rawId, 'glm-5.2')
  ) {
    return GLM_52_LEVELS
  }
  return null
}

function withLevels(
  thinking: ThinkingRequest,
  providerId: string,
  rawId: string,
): ThinkingRequest {
  const levels = levelsFor(providerId, rawId)
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
        thinking: withLevels(
          { on: OPENAI_ON, off: null, levels: null },
          providerId,
          rawId,
        ),
        maxTokensField: 'max_completion_tokens',
        developerRole: true,
        reasoningEffort: true,
      })
    case 'deepseek':
      return blank({
        thinking: withLevels(
          { on: DEEPSEEK_ON, off: DEEPSEEK_OFF, levels: null },
          providerId,
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
        thinking: withLevels(
          { on: GLM_ON, off: null, levels: null },
          providerId,
          rawId,
        ),
        maxTokensField: 'max_tokens',
        developerRole: false,
        toolStream: true,
        reasoningEffort: false,
      })
    case 'qwen':
      return blank({
        thinking: withLevels(
          { on: QWEN_ON, off: null, levels: null },
          providerId,
          rawId,
        ),
        developerRole: false,
      })
    case 'vllm':
      return blank({
        thinking: withLevels(
          { on: VLLM_QWEN_ON, off: null, levels: null },
          providerId,
          rawId,
        ),
        developerRole: false,
      })
    case 'openrouter':
      return blank({
        thinking: withLevels(
          { on: OPENROUTER_ON, off: null, levels: null },
          providerId,
          rawId,
        ),
        sessionAffinity: true,
        cacheControl: rawId.startsWith('anthropic/') ? 'anthropic' : null,
      })
    case 'together':
      return blank({
        thinking: withLevels(
          { on: TOGETHER_ON, off: null, levels: null },
          providerId,
          rawId,
        ),
        maxTokensField: 'max_tokens',
        developerRole: false,
        reasoningEffort: false,
      })
    // From Moonshot's chat spec, not probed. The international and China
    // documents agree: `max_tokens` is deprecated for
    // `max_completion_tokens`, the role enum has no `developer`, and only
    // `kimi-k3` declares `reasoning_effort`. The spec does not say the other
    // models reject it, so that stays null. For `kimi-k3` Moonshot's OpenClaw
    // guide sets `maxTokensField: "max_tokens"` against the spec, so its
    // field stays null until probed.
    case 'moonshot':
    case 'moonshotai-cn':
      return blank({
        thinking: kimiThinking(rawId),
        maxTokensField: rawId === 'kimi-k3' ? null : 'max_completion_tokens',
        developerRole: false,
        reasoningEffort: rawId === 'kimi-k3' ? true : null,
      })
    case 'nvidia':
      // reasoning_effort varies per model (kimi-k3's reference page takes
      // low/high/max), and those pages are not read yet: unknown, not false.
      return blank({
        maxTokensField: 'max_tokens',
        developerRole: false,
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
