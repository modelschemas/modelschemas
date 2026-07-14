/**
 * ElevenLabs — public OpenAPI spec at api.elevenlabs.io/openapi.json.
 * Models endpoint requires ELEVENLABS_API_KEY.
 */
import type { Activity } from '#/db/schema.ts'
import { ELEVENLABS_RELEASE_DATES, curatedReleasedAt } from './release-dates.ts'
import { fetchJson, fetchText, sha256Text, skippedResult } from './types.ts'
import type {
  ListModelsResult,
  OpenApiDocument,
  OpenApiOperation,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from './types.ts'

const ELEVENLABS_OPENAPI_URL = 'https://api.elevenlabs.io/openapi.json'
const ELEVENLABS_MODELS_URL = 'https://api.elevenlabs.io/v1/models'

/**
 * ElevenLabs' entire generation surface is audio, so every generation tag
 * maps to the single `audio` group (voices included — valid voice IDs and
 * voice settings are exactly the constraint surface this service exposes).
 * Studio, workspace, Agents Platform, pronunciation dictionaries, and the
 * other management surfaces classify to null.
 */
const ELEVENLABS_AUDIO_TAGS = new Set([
  'text-to-speech',
  'text-to-dialogue',
  'speech-to-speech',
  'speech-to-text',
  'sound-generation',
  'audio-isolation',
  'text-to-voice',
  'voices',
  'forced-alignment',
  'video-to-music',
  'music',
  'dubbing',
])

function classify(_path: string, op: OpenApiOperation): Activity | null {
  const tags = Array.isArray(op.tags) ? (op.tags as Array<string>) : []
  return tags.some((tag) => ELEVENLABS_AUDIO_TAGS.has(tag)) ? 'audio' : null
}

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const text = await fetchText(ELEVENLABS_OPENAPI_URL)
  const spec = JSON.parse(text) as OpenApiDocument
  return {
    specs: [spec],
    sources: [{ url: ELEVENLABS_OPENAPI_URL, hash: await sha256Text(text) }],
    outputStrategy: 'post-200',
  }
}

interface ElevenLabsModel {
  model_id: string
  name?: string
  can_do_text_to_speech?: boolean
  can_do_voice_conversion?: boolean
  languages?: Array<{ language_id: string; name: string }>
}

async function listModels(env: ProviderSecrets): Promise<ListModelsResult> {
  const key = env.ELEVENLABS_API_KEY
  if (!key) {
    return {
      models: [],
      ...skippedResult('elevenlabs', 'ELEVENLABS_API_KEY'),
    }
  }
  const body = (await fetchJson(ELEVENLABS_MODELS_URL, {
    headers: { 'xi-api-key': key },
  })) as Array<ElevenLabsModel>
  return {
    models: body.map((m) => ({
      rawId: m.model_id,
      displayName: m.name ?? null,
      activity: 'audio',
      // ElevenLabs' API has no release timestamp — curated dates only.
      releasedAt: curatedReleasedAt(ELEVENLABS_RELEASE_DATES, m.model_id),
      capabilities: {
        canDoTextToSpeech: m.can_do_text_to_speech,
        canDoVoiceConversion: m.can_do_voice_conversion,
        languages: m.languages?.map((l) => l.language_id),
      },
    })),
  }
}

export const elevenlabsProvider: ProviderConfig = {
  id: 'elevenlabs',
  displayName: 'ElevenLabs',
  authEnvVar: 'ELEVENLABS_API_KEY',
  fetchSpec,
  listModels,
  classify,
}
