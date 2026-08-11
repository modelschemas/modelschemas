/**
 * BytePlus (ModelArk + Seed Speech) — fully static, keyless provider.
 *
 * BytePlus publishes no public machine-readable spec and its data-plane
 * `GET /models` listing needs a region-bound Ark key AND is documented
 * non-exhaustive (e.g. `seedream-5-0-lite-260128` answers requests but is
 * missing from the listing), so both surfaces are embedded here instead,
 * ported from TanStack AI's `@tanstack/ai-byteplus` package:
 *
 * - Specs: synthesized OpenAPI documents in `byteplus-spec.ts` (from the
 *   adapter's hand-written, test-pinned wire types).
 * - Models: the curated catalog below (from the adapter's `model-meta.ts`,
 *   where every Ark id was verified live on 2026-07-31 and capability notes
 *   record probed-vs-docs-derived provenance). BytePlus retires model ids
 *   aggressively, so only dated, probe-confirmed ids ship; the two Seed
 *   Speech ids are docs-derived (`seed-asr` is a synthetic id for an
 *   endpoint-addressed API that takes no `model` field).
 *
 * Content changes only land through edits to these files — the sync engine's
 * hash-diffing then versions them like any upstream change.
 */
import type { Activity } from '#/db/schema.ts'
import { contentHash } from '#/server/kv.ts'
import {
  BYTEPLUS_ARK_DOCS_URL,
  BYTEPLUS_VOICE_DOCS_URL,
  bytePlusArkSpec,
  bytePlusVoiceSpec,
} from './byteplus-spec.ts'
import { byteplusIdSuffixDate } from './release-dates.ts'
import type {
  ListModelsResult,
  ModelInfo,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from './types.ts'

/**
 * Both hosts' generation surfaces classify by exact path (the Ark and voice
 * documents have no overlapping paths).
 */
function classify(path: string): Activity | null {
  if (path === '/chat/completions') return 'chat'
  if (path === '/images/generations') return 'image'
  if (path === '/contents/generations/tasks') return 'video'
  if (path === '/tts/create' || path === '/auc/bigmodel/recognize/flash') {
    return 'audio'
  }
  return null
}

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const ark = bytePlusArkSpec()
  const voice = bytePlusVoiceSpec()
  // Static embedded documents: provenance hashes the document itself (like
  // FAL's response-embedded specs); the URL points at the human docs the
  // shapes were derived from.
  return {
    specs: [ark, voice],
    sources: [
      { url: BYTEPLUS_ARK_DOCS_URL, hash: await contentHash(ark) },
      { url: BYTEPLUS_VOICE_DOCS_URL, hash: await contentHash(voice) },
    ],
    outputStrategy: 'post-200',
  }
}

interface CuratedModel {
  rawId: string
  activity: Activity
  contextWindow?: number
  maxOutput?: number
  input: Array<string>
  output: Array<string>
  capabilities?: unknown
}

const chat = (
  rawId: string,
  maxOutput: number,
  capabilities: Array<string>,
  input: Array<string> = ['text'],
  contextWindow = 256_000,
): CuratedModel => ({
  rawId,
  activity: 'chat',
  contextWindow,
  maxOutput,
  input,
  output: ['text'],
  capabilities,
})

const TIV = ['text', 'image', 'video']
const TIVA = ['text', 'image', 'video', 'audio']
const REASON_TOOLS = ['reasoning', 'tool_calling']
const REASON_TOOLS_SO = ['reasoning', 'tool_calling', 'structured_outputs']

const video = (
  rawId: string,
  input: Array<string>,
  output: Array<string>,
  resolutions: Array<string>,
  duration: { min: number; max: number },
): CuratedModel => ({
  rawId,
  activity: 'video',
  input,
  output,
  capabilities: { resolutions, duration },
})

const image = (rawId: string, maxReferenceImages: number): CuratedModel => ({
  rawId,
  activity: 'image',
  input: ['text', 'image'],
  output: ['image'],
  capabilities: { maxReferenceImages, sizeTokens: ['1K', '2K', '4K'] },
})

/**
 * Ported from `@tanstack/ai-byteplus` `model-meta.ts` (context windows,
 * max-output, modalities, and the probed structured-output verdicts — the
 * BytePlus capability tables are wrong in both directions, so the probe
 * results are authoritative).
 */
const BYTEPLUS_MODELS: Array<CuratedModel> = [
  // Chat (Seed / GLM / DeepSeek / gpt-oss on Ark)
  chat('dola-seed-2-1-turbo-260628', 256_000, REASON_TOOLS_SO, TIV),
  chat('seed-2-0-lite-260428', 128_000, REASON_TOOLS, TIVA),
  chat('seed-2-0-mini-260428', 128_000, REASON_TOOLS, TIVA),
  chat('seed-2-0-pro-260328', 128_000, REASON_TOOLS_SO, TIV),
  chat('seed-2-0-lite-260228', 128_000, REASON_TOOLS_SO, TIV),
  chat('seed-2-0-mini-260215', 128_000, REASON_TOOLS_SO, TIV),
  chat('seed-2-0-code-preview-260328', 128_000, REASON_TOOLS, TIV),
  chat('seed-1-8-251228', 64_000, REASON_TOOLS_SO, TIV),
  chat('seed-1-6-250915', 32_000, REASON_TOOLS_SO, TIV),
  chat('seed-1-6-250615', 32_000, REASON_TOOLS_SO, TIV),
  chat('seed-1-6-flash-250715', 32_000, REASON_TOOLS_SO, TIV),
  chat('seed-1-6-flash-250615', 32_000, REASON_TOOLS_SO, TIV),
  chat('glm-5-2-260617', 128_000, REASON_TOOLS_SO, ['text'], 1_024_000),
  chat('glm-4-7-251222', 128_000, REASON_TOOLS),
  chat('deepseek-v4-pro-260425', 384_000, REASON_TOOLS, ['text'], 1_024_000),
  chat('deepseek-v4-flash-260425', 384_000, REASON_TOOLS, ['text'], 1_024_000),
  chat('deepseek-v3-2-251201', 32_000, REASON_TOOLS, ['text'], 128_000),
  chat('gpt-oss-120b-250805', 64_000, ['reasoning'], ['text'], 128_000),
  // Video (Seedance, async task API)
  video(
    'dreamina-seedance-2-5-260628',
    TIVA,
    ['video', 'audio'],
    ['480p', '720p'],
    { min: 4, max: 30 },
  ),
  video(
    'dreamina-seedance-2-0-260128',
    TIVA,
    ['video', 'audio'],
    ['480p', '720p', '1080p', '4k'],
    { min: 4, max: 15 },
  ),
  video(
    'dreamina-seedance-2-0-fast-260128',
    TIVA,
    ['video', 'audio'],
    ['480p', '720p'],
    { min: 4, max: 15 },
  ),
  video(
    'dreamina-seedance-2-0-mini-260615',
    TIVA,
    ['video', 'audio'],
    ['480p', '720p'],
    { min: 4, max: 15 },
  ),
  video(
    'seedance-1-5-pro-251215',
    ['text', 'image'],
    ['video', 'audio'],
    ['480p', '720p', '1080p'],
    { min: 4, max: 12 },
  ),
  video(
    'seedance-1-0-pro-250528',
    ['text', 'image'],
    ['video'],
    ['480p', '720p', '1080p'],
    { min: 2, max: 12 },
  ),
  video(
    'seedance-1-0-pro-fast-251015',
    ['text', 'image'],
    ['video'],
    ['480p', '720p', '1080p'],
    { min: 2, max: 12 },
  ),
  // Image (Seedream)
  image('dola-seedream-5-0-pro-260628', 10),
  image('seedream-5-0-260128', 14),
  image('seedream-5-0-lite-260128', 14),
  image('seedream-4-5-251128', 14),
  image('seedream-4-0-250828', 14),
  // Seed Speech (voice host — separate product and API key)
  {
    rawId: 'seed-audio-1.0',
    activity: 'audio',
    input: ['text', 'audio'],
    output: ['audio'],
  },
  {
    rawId: 'seed-asr',
    activity: 'audio',
    input: ['audio'],
    output: ['text'],
  },
]

function listModels(_env: ProviderSecrets): Promise<ListModelsResult> {
  const models: Array<ModelInfo> = BYTEPLUS_MODELS.map((m) => ({
    rawId: m.rawId,
    activity: m.activity,
    contextWindow: m.contextWindow ?? null,
    maxOutput: m.maxOutput ?? null,
    modalities: { input: m.input, output: m.output },
    capabilities: m.capabilities,
    // Dated ids embed their release as a -YYMMDD suffix; the undated Seed
    // Speech ids keep their poll-time firstSeenAt.
    releasedAt: byteplusIdSuffixDate(m.rawId),
  }))
  return Promise.resolve({ models })
}

export const byteplusProvider: ProviderConfig = {
  id: 'byteplus',
  displayName: 'BytePlus',
  fetchSpec,
  listModels,
  classify,
}
