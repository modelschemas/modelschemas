/**
 * Model-list metadata that grain=provider catalogs don't get from the
 * upstream `/models` payload: activity, a display name, and the canonical
 * generation route to bind each row onto.
 *
 * Grok and OpenAI (issue #50) ship `id` + `created` only. Activity is
 * derived from the id; the generation endpoint is the shared HTTP route
 * for that activity (with a per-id split on OpenAI audio).
 */
import type { Activity } from '#/db/schema.ts'

const ACRONYMS = new Set(['gpt', 'tts', 'stt', 'asr'])

/** Human-readable label when the provider's list endpoint has no name. */
export function displayNameFromRawId(rawId: string): string {
  if (/^dall-e($|-)/i.test(rawId)) {
    const rest = rawId.replace(/^dall-e-?/i, '')
    return rest === '' ? 'DALL-E' : `DALL-E ${rest}`
  }
  return rawId
    .split(/[-_]+/)
    .filter((part) => part.length > 0)
    .map((part) => {
      if (/^\d+(\.\d+)*$/.test(part)) return part
      const lower = part.toLowerCase()
      if (ACRONYMS.has(lower)) return lower.toUpperCase()
      return part.charAt(0).toUpperCase() + part.slice(1)
    })
    .join(' ')
}

function hasSegment(rawId: string, segment: string): boolean {
  return new RegExp(`(^|-)${segment}(-|$)`, 'i').test(rawId)
}

/**
 * xAI Grok listed-model activity. Imagine ids are `grok-imagine-image*` /
 * `grok-imagine-video*`; voice ids carry a `voice` segment. Everything
 * else on the models endpoint is chat (including vision).
 */
export function grokModelActivity(rawId: string): Activity {
  const id = rawId.toLowerCase()
  if (id.includes('imagine-video') || hasSegment(id, 'video')) return 'video'
  if (
    id.includes('imagine-image') ||
    hasSegment(id, 'image') ||
    id.includes('imagine')
  ) {
    return 'image'
  }
  if (
    hasSegment(id, 'voice') ||
    hasSegment(id, 'tts') ||
    hasSegment(id, 'stt') ||
    hasSegment(id, 'asr')
  ) {
    return 'audio'
  }
  if (id.includes('embed')) return 'embeddings'
  return 'chat'
}

/** Canonical Grok generation route for an activity. No audio route yet. */
export function grokGenerationEndpointId(activity: Activity): string | null {
  switch (activity) {
    case 'image':
      return 'v1/images/generations'
    case 'video':
      return 'v1/videos/generations'
    case 'chat':
      return 'v1/chat/completions'
    case 'embeddings':
      return 'v1/embeddings'
    default:
      return null
  }
}

/**
 * OpenAI listed-model activity. Prefix / segment checks run before the
 * catch-all `gpt-` chat default so `gpt-image-*` and `gpt-4o-mini-tts`
 * don't land in chat.
 */
export function openaiModelActivity(rawId: string): Activity {
  const id = rawId.toLowerCase()
  if (
    id.startsWith('dall-e') ||
    id.startsWith('gpt-image') ||
    id.startsWith('chatgpt-image')
  ) {
    return 'image'
  }
  if (id.startsWith('sora')) return 'video'
  if (
    id.startsWith('whisper') ||
    id.startsWith('tts-') ||
    hasSegment(id, 'tts') ||
    id.includes('transcribe')
  ) {
    return 'audio'
  }
  if (id.includes('embedding') || id.startsWith('text-similarity')) {
    return 'embeddings'
  }
  if (id.includes('moderation')) return 'moderation'
  return 'chat'
}

/** Canonical OpenAI generation route; audio splits speech vs transcription. */
export function openaiGenerationEndpointId(
  rawId: string,
  activity: Activity,
): string | null {
  switch (activity) {
    case 'image':
      return 'images/generations'
    case 'video':
      return 'videos'
    case 'chat':
      return 'chat/completions'
    case 'embeddings':
      return 'embeddings'
    case 'moderation':
      return 'moderations'
    case 'audio': {
      const id = rawId.toLowerCase()
      if (id.startsWith('whisper') || id.includes('transcribe')) {
        return 'audio/transcriptions'
      }
      return 'audio/speech'
    }
    default:
      return null
  }
}

/** Gemini path-templated generation route from activity + methods. */
export function geminiGenerationEndpointId(
  activity: Activity,
  capabilities: unknown,
): string | null {
  const methods = Array.isArray(capabilities)
    ? capabilities.filter((value): value is string => typeof value === 'string')
    : []
  switch (activity) {
    case 'image':
      return methods.includes('predict')
        ? 'v1beta/models/{modelsId}:predict'
        : 'v1beta/models/{modelsId}:generateContent'
    case 'video':
      return 'v1beta/models/{modelsId}:predictLongRunning'
    case 'embeddings':
      return 'v1beta/models/{modelsId}:embedContent'
    case 'chat':
    case 'audio':
      return 'v1beta/models/{modelsId}:generateContent'
    default:
      return null
  }
}

function outputModalities(value: unknown): Array<string> {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

/**
 * OpenRouter activity from architecture.output_modalities. Video and
 * embeddings are unique; image/audio only win when text is absent so
 * GPT-4o-style image-capable chat stays in chat.
 */
export function openrouterModelActivity(output: unknown): Activity {
  const out = outputModalities(output).map((item) => item.toLowerCase())
  if (out.includes('video')) return 'video'
  if (out.includes('embedding') || out.includes('embeddings')) {
    return 'embeddings'
  }
  if (out.includes('image') && !out.includes('text')) return 'image'
  if (out.includes('audio') && !out.includes('text')) return 'audio'
  return 'chat'
}

/**
 * OpenRouter generation route. Video models have a synthesised per-id
 * path; image has no classified generation route on the spec.
 */
export function openrouterGenerationEndpointId(
  rawId: string,
  activity: Activity,
): string | null {
  switch (activity) {
    case 'video':
      return `videos/${rawId}`
    case 'chat':
      return 'chat/completions'
    case 'embeddings':
      return 'embeddings'
    case 'audio':
      return 'audio/speech'
    default:
      return null
  }
}

/** BFL model ids are the path suffix (`flux-2-pro` → `/v1/flux-2-pro`). */
export function bflModelActivity(rawId: string): Activity {
  return rawId.toLowerCase().includes('video') ? 'video' : 'image'
}

export function bflGenerationEndpointId(rawId: string): string {
  return `v1/${rawId}`
}

/** BytePlus Ark/Seed Speech generation routes. ASR vs TTS split on the id. */
export function byteplusGenerationEndpointId(
  rawId: string,
  activity: Activity,
): string | null {
  switch (activity) {
    case 'chat':
      return 'chat/completions'
    case 'image':
      return 'images/generations'
    case 'video':
      return 'contents/generations/tasks'
    case 'audio':
      return /asr|recognize/i.test(rawId)
        ? 'auc/bigmodel/recognize/flash'
        : 'tts/create'
    default:
      return null
  }
}
