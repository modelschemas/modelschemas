/**
 * Cartesia — real-time TTS/STT. The OpenAPI URL is `openapi_spec_url` in
 * cartesia-python `.stats.yml` when Stainless publishes one. There is no
 * fallback: the old GCS object is private (403), and docs.cartesia.ai
 * OpenAPI URLs redirect to a login even with `CARTESIA_API_KEY`
 * (issue #523). A missing URL throws, so spec sync stays degraded and the
 * last stored schemas keep being served.
 * Voices stand in for models. Requests need a Cartesia-Version header.
 *
 * No per-voice USD rate. https://docs.cartesia.ai/pricing meters credits
 * (about 1 per character, or per second of audio) and
 * https://cartesia.ai/pricing sells those credits in plan bundles. The
 * Scale-plan "$0.39 per hour" Ink line is not the rate on every plan, so
 * every voice stays null (issue #121).
 */
import type { Activity } from '#/db/schema.ts'
import { normalizeMediaModalities } from '../media-modalities.ts'
import { isoToEpochSeconds } from '../release-dates.ts'
import {
  fetchJson,
  fetchOpenApi,
  fetchText,
  skippedResult,
  stainlessSpecUrlFromStats,
} from '../types.ts'
import type {
  ListModelsResult,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

export const CARTESIA_STATS_URL =
  'https://raw.githubusercontent.com/cartesia-ai/cartesia-python/main/.stats.yml'
export const CARTESIA_VOICES_URL = 'https://api.cartesia.ai/voices'
export const CARTESIA_VERSION = '2026-03-01'

function pathMatches(path: string, prefix: string): boolean {
  const bare = path.split('?')[0] ?? path
  return bare === prefix || bare.startsWith(`${prefix}/`)
}

/**
 * Generation surface is TTS, STT, infill, and voice-changer. Agents, voice
 * library admin, datasets, fine-tunes, files, and auth classify null.
 */
function classify(path: string): Activity | null {
  if (
    pathMatches(path, '/tts') ||
    pathMatches(path, '/stt') ||
    pathMatches(path, '/infill') ||
    pathMatches(path, '/voice-changer') ||
    pathMatches(path, '/audio/transcriptions')
  ) {
    return 'audio'
  }
  return null
}

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const text = await fetchText(CARTESIA_STATS_URL)
  const url = stainlessSpecUrlFromStats(text, 'cartesia')
  if (!url.startsWith('https://')) {
    throw new Error('cartesia .stats.yml: openapi_spec_url is not https')
  }
  const { spec, hash } = await fetchOpenApi(url)
  return {
    specs: [spec],
    sources: [{ url, hash }],
    outputStrategy: 'post-200',
    specRevision: url,
  }
}

interface CartesiaVoice {
  id?: string
  name?: string
  created_at?: string
}

interface CartesiaVoiceList {
  data?: Array<CartesiaVoice>
  has_more?: boolean
  next_page?: string | null
}

async function listModels(env: ProviderSecrets): Promise<ListModelsResult> {
  const key = env.CARTESIA_API_KEY
  if (!key) {
    return { models: [], ...skippedResult('cartesia', 'CARTESIA_API_KEY') }
  }
  const headers = {
    Authorization: `Bearer ${key}`,
    'Cartesia-Version': CARTESIA_VERSION,
  }
  const models: ListModelsResult['models'] = []
  let after: string | undefined
  do {
    const url = new URL(CARTESIA_VOICES_URL)
    url.searchParams.set('limit', '100')
    if (after) url.searchParams.set('starting_after', after)
    const body = (await fetchJson(url.toString(), {
      headers,
    })) as CartesiaVoiceList
    for (const voice of body.data ?? []) {
      if (typeof voice.id !== 'string' || voice.id.length === 0) continue
      models.push({
        rawId: voice.id,
        displayName: voice.name ?? null,
        activity: 'audio',
        // Voices are the TTS catalog. STT uses a separate model id.
        modalities: normalizeMediaModalities({
          activity: 'audio',
          listingInput: ['text'],
          listingOutput: ['audio'],
        }),
        releasedAt: isoToEpochSeconds(voice.created_at),
      })
    }
    after = body.has_more && body.next_page ? body.next_page : undefined
  } while (after)
  return { models }
}

export const provider: ProviderConfig = {
  id: 'cartesia',
  displayName: 'Cartesia',
  authEnvVar: 'CARTESIA_API_KEY',
  specSourceUrl: CARTESIA_STATS_URL,
  modelsEndpoint: CARTESIA_VOICES_URL,
  defaultDerivation: 'upstream-spec',
  fetchSpec,
  listModels,
  classify,
  generationEndpointId: () => 'tts/bytes',
}
