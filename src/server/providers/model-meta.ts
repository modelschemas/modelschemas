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
