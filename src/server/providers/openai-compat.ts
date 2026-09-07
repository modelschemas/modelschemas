/**
 * Helpers for OpenAI-compatible providers that do not publish their own
 * spec. fetchSpec pulls the canonical OpenAI document, keeps only the
 * requested generation paths, and rewrites `servers` to the provider host.
 *
 * Derivation is `generated`: the schemas come from OpenAI's spec, not a
 * document the provider itself publishes.
 */
import type { Activity } from '#/db/schema.ts'
import type { ModelFacts } from './model-facts.ts'
import { OPENAI_SPEC_URL } from './openai.ts'
import { fetchJson, fetchOpenApi, skippedResult } from './types.ts'
import type {
  ListModelsResult,
  OpenApiDocument,
  ProviderSecrets,
} from './types.ts'

export { OPENAI_SPEC_URL as OPENAI_OPENAPI_URL }

export const OPENAI_COMPAT_PATHS = [
  '/chat/completions',
  '/completions',
  '/responses',
  '/embeddings',
  '/audio/speech',
  '/audio/transcriptions',
  '/audio/translations',
  '/images/generations',
  '/images/edits',
  '/images/variations',
  '/videos',
  '/moderations',
] as const

export type OpenAiCompatPath = (typeof OPENAI_COMPAT_PATHS)[number]

const PATH_ACTIVITIES: Record<OpenAiCompatPath, Activity> = {
  '/chat/completions': 'chat',
  '/completions': 'chat',
  '/responses': 'chat',
  '/embeddings': 'embeddings',
  '/audio/speech': 'audio',
  '/audio/transcriptions': 'audio',
  '/audio/translations': 'audio',
  '/images/generations': 'image',
  '/images/edits': 'image',
  '/images/variations': 'image',
  '/videos': 'video',
  '/moderations': 'moderation',
}

export interface OpenAiCompatSpecOptions {
  title: string
  /** Origin + version prefix the provider actually serves, e.g. https://api.groq.com/openai/v1 */
  serverUrl: string
  include: ReadonlyArray<OpenAiCompatPath>
}

export function classifyOpenAiCompat(path: string): Activity | null {
  const bare = path.startsWith('/v1/') ? path.slice(3) : path
  if (bare in PATH_ACTIVITIES) {
    return PATH_ACTIVITIES[bare as OpenAiCompatPath]
  }
  return null
}

export function filterOpenAiSpec(
  spec: OpenApiDocument,
  opts: OpenAiCompatSpecOptions,
): OpenApiDocument {
  const paths: NonNullable<OpenApiDocument['paths']> = {}
  for (const path of opts.include) {
    const operations = spec.paths?.[path]
    if (operations) paths[path] = operations
  }
  return {
    ...spec,
    info: { ...(spec.info ?? {}), title: opts.title },
    servers: [{ url: opts.serverUrl }],
    paths,
  }
}

export async function fetchOpenAiCompatibleSpec(
  opts: OpenAiCompatSpecOptions,
): Promise<{
  spec: OpenApiDocument
  url: string
  hash: string
}> {
  const { spec, hash } = await fetchOpenApi(OPENAI_SPEC_URL)
  return {
    spec: filterOpenAiSpec(spec, opts),
    url: OPENAI_SPEC_URL,
    hash,
  }
}

/**
 * Extension fields OpenAI-compatible providers put on their `/models` rows
 * (issue #53). Names vary per host; this is the union seen across groq,
 * jina, fireworks, moonshot, sambanova, hyperbolic and mistral. Absent
 * fields stay null — nothing is inferred beyond what the row says.
 */
export interface OpenAiCompatModelRow {
  id: string
  created?: number
  context_window?: number
  context_length?: number
  max_context_length?: number
  max_completion_tokens?: number
  max_output_length?: number
  input_modalities?: Array<string>
  output_modalities?: Array<string>
  supports_image_input?: boolean
  supports_image_in?: boolean
  supports_video_in?: boolean
  supports_tools?: boolean
  supports_reasoning?: boolean
  /** groq/jina: `tools`, `json_mode`, `structured_outputs`, `reasoning`. */
  supported_features?: Array<string>
  /** groq/jina: `temperature`, `top_p`, `stop`, `seed`, `max_tokens`. */
  supported_sampling_parameters?: Array<string>
  /** mistral: `{ function_calling, reasoning, vision, … }`. */
  capabilities?: Record<string, boolean | undefined>
}

const positive = (n: number | undefined) =>
  typeof n === 'number' && n > 0 ? n : null

/**
 * Catalog facts from whatever extension fields a compat row carries. Only
 * facts the row states are returned, so bare `id`+`created` rows stay bare.
 */
export function openAiCompatModelFacts(
  m: OpenAiCompatModelRow,
): Partial<ModelFacts> {
  const flags = m.capabilities ?? {}
  const features = new Set(m.supported_features ?? [])
  const sampling = new Set(m.supported_sampling_parameters ?? [])

  let modalities: ModelFacts['modalities'] = null
  if (m.input_modalities || m.output_modalities) {
    modalities = {
      input: m.input_modalities ?? [],
      output: m.output_modalities ?? [],
    }
  } else if (
    m.supports_image_input !== undefined ||
    m.supports_image_in !== undefined ||
    flags.vision !== undefined
  ) {
    const input = ['text']
    if (m.supports_image_input || m.supports_image_in || flags.vision) {
      input.push('image')
    }
    if (m.supports_video_in) input.push('video')
    modalities = { input, output: ['text'] }
  }

  const caps: Array<string> = []
  if (features.has('tools') || m.supports_tools || flags.function_calling) {
    caps.push('tools', 'tool_choice')
  }
  if (features.has('reasoning') || m.supports_reasoning || flags.reasoning) {
    caps.push('reasoning')
  }
  for (const param of ['temperature', 'top_p', 'top_k']) {
    if (sampling.has(param)) caps.push(param)
  }
  if (features.has('structured_outputs')) caps.push('structured_outputs')
  if (features.has('json_mode') || features.has('structured_outputs')) {
    caps.push('response_format')
  }

  const facts: Partial<ModelFacts> = {}
  const contextWindow = positive(
    m.context_window ?? m.context_length ?? m.max_context_length,
  )
  const maxOutput = positive(m.max_completion_tokens ?? m.max_output_length)
  if (contextWindow !== null) facts.contextWindow = contextWindow
  if (maxOutput !== null) facts.maxOutput = maxOutput
  if (modalities) facts.modalities = modalities
  if (caps.length > 0) facts.capabilities = caps
  return facts
}

interface OpenAiModelList {
  data?: Array<OpenAiCompatModelRow>
}

export async function listOpenAiCompatibleModels(opts: {
  providerId: string
  url: string
  env: ProviderSecrets
  envVar: keyof ProviderSecrets
  /**
   * Extra headers (e.g. Deepgram Token, Cartesia-Version). Authorization
   * is filled in as Bearer unless `authorization` is set.
   */
  headers?: Record<string, string>
  authorization?: string
}): Promise<ListModelsResult> {
  const key = opts.env[opts.envVar]
  if (!key) {
    return { models: [], ...skippedResult(opts.providerId, opts.envVar) }
  }
  const headers: Record<string, string> = {
    Authorization: opts.authorization ?? `Bearer ${key}`,
    ...opts.headers,
  }
  const body = (await fetchJson(opts.url, { headers })) as OpenAiModelList
  return {
    models: (body.data ?? [])
      .filter((m) => typeof m.id === 'string' && m.id.length > 0)
      .map((m) => ({
        rawId: m.id,
        releasedAt: m.created ?? null,
        ...openAiCompatModelFacts(m),
      })),
  }
}
