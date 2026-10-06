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

/**
 * Gemini path-templated generation route from activity + the Models API's
 * `supportedGenerationMethods` (`predict` → Imagen). Decided at list time
 * and stored as `schemaEndpointId`. The config fallback still reads leftover
 * methods from `capabilities` for rows the poller has not rewritten yet.
 */
export function geminiGenerationEndpointId(
  activity: Activity,
  methods: Array<string>,
): string | null {
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

/**
 * Groq listed-model activity from `output_modalities` (issue #72):
 * `speech` (Orpheus TTS) and `transcription` (Whisper) are audio,
 * everything else — prompt-guard and safeguard included — is chat.
 */
export function groqModelActivity(m: {
  id: string
  output_modalities?: Array<string>
}): Activity {
  const out = outputModalities(m.output_modalities)
  if (out.includes('speech') || out.includes('transcription')) return 'audio'
  if (/whisper|orpheus|tts/i.test(m.id)) return 'audio'
  return 'chat'
}

/** Groq routes keep the Stainless `openai/` prefix. */
export function groqGenerationEndpointId(
  rawId: string,
  activity: Activity,
): string | null {
  switch (activity) {
    case 'chat':
      return 'openai/v1/chat/completions'
    case 'embeddings':
      return 'openai/v1/embeddings'
    case 'audio':
      return /whisper|transcri/i.test(rawId)
        ? 'openai/v1/audio/transcriptions'
        : 'openai/v1/audio/speech'
    default:
      return null
  }
}

/**
 * Mistral listed-model activity from its `capabilities` flags (issue #72).
 * Embedding rows carry no flags, so they fall back to the id. OCR models
 * serve only `/v1/ocr`, which is not a classified route — null.
 */
export function mistralModelActivity(m: {
  id: string
  capabilities?: Record<string, boolean | undefined>
}): Activity | null {
  const flags = m.capabilities ?? {}
  if (flags.moderation) return 'moderation'
  if (flags.completion_chat) return 'chat'
  if (
    flags.audio_speech ||
    flags.audio_transcription ||
    flags.audio_transcription_realtime
  ) {
    return 'audio'
  }
  if (m.id.toLowerCase().includes('embed')) return 'embeddings'
  return null
}

/** Mistral route; realtime transcription is websocket-only (no route). */
export function mistralGenerationEndpointId(
  rawId: string,
  activity: Activity,
): string | null {
  switch (activity) {
    case 'chat':
      return 'v1/chat/completions'
    case 'embeddings':
      return 'v1/embeddings'
    case 'moderation':
      return 'v1/moderations'
    case 'audio': {
      const id = rawId.toLowerCase()
      if (id.includes('tts')) return 'v1/audio/speech'
      return id.includes('realtime') ? null : 'v1/audio/transcriptions'
    }
    default:
      return null
  }
}

/**
 * OpenAI-compat route id. `prefix` is `v1/` when the published spec keeps
 * the version in the path, and empty when the server URL already includes it.
 */
export function compatGenerationEndpointId(
  activity: Activity,
  prefix = '',
  audio: 'speech' | 'transcriptions' = 'speech',
): string | null {
  switch (activity) {
    case 'chat':
      return `${prefix}chat/completions`
    case 'embeddings':
      return `${prefix}embeddings`
    case 'image':
      return `${prefix}images/generations`
    case 'video':
      return `${prefix}videos`
    case 'audio':
      return `${prefix}audio/${audio}`
    case 'moderation':
      return `${prefix}moderations`
    default:
      return null
  }
}

/** Text plus the image/video inputs the row's booleans name. Output is text. */
export function flaggedChatModalities(m: {
  supports_image_in?: boolean
  supports_video_in?: boolean
  supports_image_input?: boolean
}): { input: Array<string>; output: Array<string> } {
  const input = ['text']
  if (m.supports_image_in || m.supports_image_input) input.push('image')
  if (m.supports_video_in) input.push('video')
  return { input, output: ['text'] }
}

/** DeepSeek rows name output modalities. Text out is chat. */
export function deepseekModelActivity(m: {
  output_modalities?: Array<string>
}): Activity | null {
  return m.output_modalities?.includes('text') ? 'chat' : null
}

/** Cerebras' models API is the chat catalog; rows carry no type field. */
export function cerebrasModelActivity(): Activity {
  return 'chat'
}

/** Moonshot rows are chat. Image and video are input flags, not activities. */
export function moonshotModelActivity(): Activity {
  return 'chat'
}

/**
 * Fireworks `kind` distinguishes embeddings. A reranker id has no
 * classified route. `supports_chat` is the chat flag.
 */
export function fireworksModelActivity(m: {
  id: string
  kind?: string
  supports_chat?: boolean
}): Activity | null {
  if (m.kind === 'EMBEDDING_MODEL') return 'embeddings'
  if (/rerank/i.test(m.id)) return null
  if (m.supports_chat) return 'chat'
  return null
}

export function fireworksModalities(m: {
  kind?: string
  supports_image_input?: boolean
}): { input: Array<string>; output: Array<string> } | null {
  if (m.kind === undefined && m.supports_image_input === undefined) return null
  if (m.kind === 'EMBEDDING_MODEL') {
    return { input: ['text'], output: ['embeddings'] }
  }
  return flaggedChatModalities(m)
}

/** Novita `model_type`. Unknown types stay unbound. */
export function novitaModelActivity(m: {
  model_type?: string
}): Activity | null {
  switch (m.model_type) {
    case 'chat':
      return 'chat'
    case 'image':
      return 'image'
    case 'video':
      return 'video'
    case 'audio':
      return 'audio'
    case 'embedding':
    case 'embeddings':
      return 'embeddings'
    default:
      return null
  }
}

/** Perplexity's models list is the chat/agent catalog (no type field). */
export function perplexityModelActivity(): Activity {
  return 'chat'
}

/**
 * Jina names output modalities. Text out is chat except rerank and
 * ColBERT, which are not the chat route.
 */
export function jinaModelActivity(m: {
  id: string
  output_modalities?: Array<string>
}): Activity | null {
  const out = m.output_modalities ?? []
  if (out.includes('embeddings')) return 'embeddings'
  if (out.includes('text') && !/rerank|colbert/i.test(m.id)) return 'chat'
  return null
}

/** SambaNova's models API is chat completions only; rows have no type. */
export function sambanovaModelActivity(): Activity {
  return 'chat'
}

export function hyperbolicModelActivity(m: {
  supports_chat?: boolean
}): Activity | null {
  return m.supports_chat ? 'chat' : null
}

const DASHSCOPE_CHAT = new Set([
  'TG',
  'VU',
  'Reasoning',
  'Multimodal-Omni',
  'Realtime-Omni',
  'Realtime-Chatting',
])

const DASHSCOPE_AUDIO = new Set([
  'ASR',
  'TTS',
  'Realtime-ASR',
  'Realtime-Text-to-Speech',
  'Realtime-Audio-Translate',
])

/** DashScope native `capabilities` plus response modality. */
export function dashscopeModelActivity(m: {
  capabilities?: Array<string>
  inference_metadata?: { response_modality?: Array<string> }
}): Activity | null {
  const caps = new Set(m.capabilities ?? [])
  const out = new Set(
    (m.inference_metadata?.response_modality ?? []).map((value) =>
      value.toLowerCase(),
    ),
  )
  if (caps.has('IG') || (out.has('image') && !out.has('text'))) return 'image'
  if (caps.has('VG') || (out.has('video') && !out.has('text'))) return 'video'
  if (caps.has('TR') || caps.has('ME')) return 'embeddings'
  if ([...DASHSCOPE_AUDIO].some((cap) => caps.has(cap))) return 'audio'
  if (out.has('audio') && !out.has('text')) return 'audio'
  if ([...DASHSCOPE_CHAT].some((cap) => caps.has(cap)) || out.has('text')) {
    return 'chat'
  }
  return null
}
