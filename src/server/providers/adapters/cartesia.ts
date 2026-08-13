/**
 * Cartesia — real-time TTS/STT. Official OpenAPI is Stainless-hosted;
 * cartesia-python `.stats.yml` exposes `openapi_spec_url` when present.
 * Voices stand in for models. Requests need a Cartesia-Version header.
 */
import type { Activity } from '#/db/schema.ts'
import { isoToEpochSeconds } from '../release-dates.ts'
import { fetchJson, fetchOpenApi, fetchText, skippedResult } from '../types.ts'
import type {
  ListModelsResult,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

export const CARTESIA_STATS_URL =
  'https://raw.githubusercontent.com/cartesia-ai/cartesia-python/main/.stats.yml'
/**
 * Last published Stainless spec (hash-stamped GCS). Used when `.stats.yml`
 * no longer lists `openapi_spec_url` (current file is endpoints-only).
 */
export const CARTESIA_SPEC_FALLBACK_URL =
  'https://storage.googleapis.com/stainless-sdk-openapi-specs/cartesia-noahlt/noah-testing-f9cc29df072fe2838347fe9845e6384708bec9c3937ad7a63c3e72650c1bd891.yml'
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

function specUrlFromStats(text: string): string | null {
  const match = text.match(/^openapi_spec_url:\s*(.+)$/m)
  const url = match?.[1]?.trim()
  return url && url.startsWith('https://') ? url : null
}

async function resolveSpecUrl(): Promise<{ url: string; warning?: string }> {
  try {
    const text = await fetchText(CARTESIA_STATS_URL)
    const url = specUrlFromStats(text)
    if (url) return { url }
  } catch {
    // Fall through to the last published official spec.
  }
  return {
    url: CARTESIA_SPEC_FALLBACK_URL,
    warning:
      'cartesia: Stainless .stats.yml has no openapi_spec_url — using last published spec',
  }
}

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const { url, warning } = await resolveSpecUrl()
  const { spec, hash } = await fetchOpenApi(url)
  return {
    specs: [spec],
    sources: [{ url, hash }],
    outputStrategy: 'post-200',
    specRevision: url,
    warnings: warning ? [warning] : undefined,
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
}
