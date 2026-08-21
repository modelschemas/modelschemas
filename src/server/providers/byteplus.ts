/**
 * BytePlus (ModelArk + Seed Speech) — SDK-generated specs, live models.
 *
 * BytePlus publishes no OpenAPI document: `/openapi.json`, `/swagger.json`
 * and `/docs` on the Ark data plane all answer 200 with an EMPTY body (a
 * catch-all, not a document — re-probed with a real key 2026-08-12), and the
 * genuine per-action documents live behind the console's API Explorer, which
 * needs an interactive login.
 *
 * It does, however, publish an official Go SDK whose model package declares
 * the entire Ark data plane as `json:"…"`-tagged structs. Those are plain
 * text, so `fetchSpec` pulls them from GitHub on the ordinary spec-sync cron
 * and `byteplus-ark-build.ts` turns them into the Ark document — the spec
 * tracks upstream SDK releases with no codegen step and no committed
 * artifact. `byteplus-spec.ts` keeps the hand-ported document as the fallback
 * for when GitHub is unreachable or the SDK is refactored past what the
 * parser handles.
 *
 * Seed Speech appears in no BytePlus SDK in any language, so the voice
 * document stays hand-written.
 *
 * The MODEL CATALOG is different: Ark's data-plane `GET /models` is a real,
 * richly-typed source (created / task_type / token_limits / modalities /
 * features / status), so `listModels` prefers it whenever `ARK_API_KEY` is
 * set. Two things keep the curated catalog alive underneath it:
 *
 * 1. The listing is NOT exhaustive — `seedream-5-0-lite-260128` answers
 *    requests but is absent from it (confirmed live 2026-08-12).
 * 2. Seed Speech (TTS/ASR) lives on a different host entirely and appears in
 *    no Ark listing.
 *
 * So the live rows win where they exist and the curated entries fill the
 * gaps; with no key at all the provider still serves the curated catalog
 * rather than reporting itself skipped.
 */
import type { Activity } from '#/db/schema.ts'
import { errorMessage } from '#/server/errors.ts'
import { contentHash } from '#/server/kv.ts'
import {
  ARK_GO_FILES,
  ARK_GO_SOURCE_URL,
  arkGoFileUrl,
  buildArkSpecFromGo,
} from './byteplus-ark-build.ts'
import { bearerConnect, headerApiKeyConnect } from './connect.ts'
import {
  BYTEPLUS_ARK_BASE_URL,
  BYTEPLUS_ARK_DOCS_URL,
  BYTEPLUS_VOICE_BASE_URL,
  BYTEPLUS_VOICE_DOCS_URL,
  bytePlusArkSpec,
  bytePlusVoiceSpec,
} from './byteplus-spec.ts'
import { byteplusIdSuffixDate } from './release-dates.ts'
import { fetchJson, fetchText, sha256Text } from './types.ts'
import type {
  ListModelsResult,
  ModelInfo,
  OpenApiDocument,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
  SpecSource,
} from './types.ts'

const ARK_MODELS_URL = 'https://ark.ap-southeast.bytepluses.com/api/v3/models'

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

/**
 * Ark half: generated from BytePlus's Go SDK so it tracks upstream releases.
 * Falls back to the embedded document — never to nothing — if GitHub is
 * unreachable or the SDK is refactored beyond what the parser handles, so a
 * bad upstream day degrades the spec's freshness rather than the service.
 */
async function fetchArkSpec(): Promise<{
  spec: OpenApiDocument
  source: SpecSource
  warnings: Array<string>
}> {
  try {
    const files = await Promise.all(
      ARK_GO_FILES.map(async (name) => ({
        name,
        text: await fetchText(arkGoFileUrl(name)),
      })),
    )
    const { spec, warnings } = buildArkSpecFromGo(files)
    return {
      spec,
      source: {
        url: ARK_GO_SOURCE_URL,
        // One document from many files: hash their concatenation in the
        // fixed ARK_GO_FILES order so the digest is reproducible.
        hash: await sha256Text(files.map((f) => f.text).join('')),
      },
      warnings,
    }
  } catch (error) {
    const spec = bytePlusArkSpec()
    return {
      spec,
      source: { url: BYTEPLUS_ARK_DOCS_URL, hash: await contentHash(spec) },
      warnings: [
        `byteplus: Go SDK spec generation failed (${errorMessage(error)}) — served the embedded Ark document instead`,
      ],
    }
  }
}

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const ark = await fetchArkSpec()
  // Seed Speech appears in no BytePlus SDK in any language, so the voice
  // document stays hand-written; provenance hashes the document itself (the
  // FAL embedded-spec precedent).
  const voice = bytePlusVoiceSpec()
  return {
    specs: [ark.spec, voice],
    sources: [
      ark.source,
      { url: BYTEPLUS_VOICE_DOCS_URL, hash: await contentHash(voice) },
    ],
    outputStrategy: 'post-200',
    warnings: ark.warnings,
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

function curatedModels(): Array<ModelInfo> {
  return BYTEPLUS_MODELS.map((m) => ({
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
}

/**
 * Ark reports one or more `task_type`s per model. Highest-precedence match
 * wins: a chat model that also accepts audio input carries `SpeechToText`
 * alongside `TextGeneration` (e.g. seed-2-0-lite-260428) and must classify as
 * `chat`, not `audio`, so the generation task types are checked first.
 * 3D-generation models carry no task_type at all and fall through to null —
 * the same treatment FAL's `text-to-3d` gets until the taxonomy grows.
 */
const ARK_TASK_ACTIVITIES: Array<[Activity, Array<string>]> = [
  [
    'video',
    [
      'TextToVideo',
      'ImageToVideo',
      'MultimodalToVideo',
      'VideoEditing',
      'VideoExtension',
    ],
  ],
  ['image', ['TextToImage', 'ImageToImage']],
  ['embeddings', ['TextEmbedding', 'ImageEmbedding', 'MultimodalEmbedding']],
  ['chat', ['TextGeneration', 'VisualQuestionAnswering']],
  ['audio', ['SpeechToText', 'TextToSpeech']],
]

export function arkTaskActivity(
  taskTypes: Array<string> | undefined,
): Activity | null {
  if (!taskTypes?.length) return null
  for (const [activity, types] of ARK_TASK_ACTIVITIES) {
    if (taskTypes.some((t) => types.includes(t))) return activity
  }
  return null
}

interface ArkModel {
  id: string
  name?: string
  created?: number
  /** Absent for live models; 'Shutdown' / 'Retiring' once wound down. */
  status?: string
  domain?: string
  task_type?: Array<string>
  modalities?: {
    input_modalities?: Array<string>
    output_modalities?: Array<string>
  }
  token_limits?: {
    context_window?: number
    max_input_token_length?: number
    max_output_token_length?: number
    max_reasoning_token_length?: number
  }
  features?: Record<string, unknown>
  version?: string
}

/**
 * Ark's `features.structured_outputs.json_schema` is NOT reliable: probed
 * 2026-08-12, `seed-2-0-lite-260428` advertises `json_schema: true` and then
 * answers a schema-bearing request with
 * `400 InvalidParameter … json_schema is not supported by this model`, while
 * `seed-2-0-lite-260228` (same family) accepts one. Both outcomes match
 * TanStack AI's 2026-07-31 sweep of all 18 chat models, so their probe
 * verdicts are carried here as a separate, clearly-labelled capability rather
 * than letting the upstream flag stand alone. Ids outside this set get no
 * verdict (absence ≠ unsupported).
 */
const PROBED_STRUCTURED_OUTPUT: Record<string, boolean> = {
  'dola-seed-2-1-turbo-260628': true,
  'seed-2-0-pro-260328': true,
  'seed-2-0-lite-260228': true,
  'seed-2-0-mini-260215': true,
  'seed-1-8-251228': true,
  'seed-1-6-250915': true,
  'seed-1-6-250615': true,
  'seed-1-6-flash-250715': true,
  'seed-1-6-flash-250615': true,
  'glm-5-2-260617': true,
  'seed-2-0-lite-260428': false,
  'seed-2-0-mini-260428': false,
  'seed-2-0-code-preview-260328': false,
  'deepseek-v4-pro-260425': false,
  'deepseek-v4-flash-260425': false,
  'deepseek-v3-2-251201': false,
  'gpt-oss-120b-250805': false,
  // Accepts the request with 200 but ignores the schema and answers in prose
  // — a status-code-only probe reads this as support.
  'glm-4-7-251222': false,
}

function toModelInfo(m: ArkModel): ModelInfo {
  const probed = PROBED_STRUCTURED_OUTPUT[m.id]
  return {
    rawId: m.id,
    displayName: m.name ?? null,
    activity: arkTaskActivity(m.task_type),
    contextWindow: m.token_limits?.context_window ?? null,
    maxOutput: m.token_limits?.max_output_token_length ?? null,
    modalities: {
      input: m.modalities?.input_modalities,
      output: m.modalities?.output_modalities,
    },
    capabilities: {
      ...m.features,
      taskType: m.task_type,
      domain: m.domain || undefined,
      maxReasoningTokens: m.token_limits?.max_reasoning_token_length,
      // Distinct key from the upstream `structured_outputs` block above so
      // the disagreement stays visible instead of one silently winning.
      ...(probed === undefined ? {} : { structuredOutputProbed: probed }),
    },
    // 'Retiring' models still serve but are on the way out; both states are
    // deprecation signals for consumers picking a model today.
    deprecated: m.status === 'Shutdown' || m.status === 'Retiring',
    releasedAt: m.created ?? byteplusIdSuffixDate(m.id),
  }
}

async function listModels(env: ProviderSecrets): Promise<ListModelsResult> {
  const key = env.ARK_API_KEY
  // No key: the embedded catalog is still a real answer, so serve it rather
  // than reporting the provider skipped.
  if (!key) return { models: curatedModels() }

  const body = (await fetchJson(ARK_MODELS_URL, {
    headers: { Authorization: `Bearer ${key}` },
  })) as { data?: Array<ArkModel> }
  const live = (body.data ?? []).map(toModelInfo)

  // Curated entries the listing omits: Seed Speech (different host) and ids
  // Ark serves but does not enumerate.
  const liveIds = new Set(live.map((m) => m.rawId))
  const gapFillers = curatedModels().filter((m) => !liveIds.has(m.rawId))
  return { models: [...live, ...gapFillers] }
}

export const byteplusProvider: ProviderConfig = {
  id: 'byteplus',
  displayName: 'BytePlus',
  // Optional, not required: it upgrades the model catalog from embedded to
  // live. fetchSpec never needs it, and listModels degrades to the curated
  // catalog without it.
  authEnvVar: 'ARK_API_KEY',
  // Overridden per operation: the generated Ark document stamps
  // 'generated', and the Seed Speech document stamps its own verified
  // status. This default only applies if a marker is ever missing.
  defaultDerivation: 'probe-verified',
  specGrain: 'provider',
  // Default document is Ark. Seed Speech (`?activity=audio`) uses a
  // different host and X-Api-Key — a combined profile would send Bearer
  // to the voice host.
  connect: bearerConnect(BYTEPLUS_ARK_BASE_URL, 'Ark'),
  connectByActivity: {
    audio: headerApiKeyConnect(BYTEPLUS_VOICE_BASE_URL, 'X-Api-Key'),
  },
  fetchSpec,
  listModels,
  classify,
}
