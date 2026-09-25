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
 * jina, fireworks, moonshot, sambanova, hyperbolic, mistral, novita and
 * cohere. Absent fields are omitted — nothing is inferred beyond what the
 * row says.
 */
export interface OpenAiCompatModelRow {
  id: string
  /** mistral: canonical id, differs from `id` on `-latest` aliases. */
  name?: string
  created?: number
  context_window?: number
  context_length?: number
  max_context_length?: number
  context_size?: number
  max_completion_tokens?: number
  max_output_length?: number
  max_output_tokens?: number
  input_modalities?: Array<string>
  output_modalities?: Array<string>
  supports_tools?: boolean
  supports_reasoning?: boolean
  /** groq/jina: `tools`, `json_mode`, `structured_outputs`, `reasoning`. */
  supported_features?: Array<string>
  /**
   * novita: `function-calling`, `structured-outputs`, `reasoning`;
   * cohere: `tools`, `tool_choice`, `json_mode`, `json_schema`,
   * `reasoning`, `vision`.
   */
  features?: Array<string>
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
  const features = new Set(
    [...(m.supported_features ?? []), ...(m.features ?? [])].map((f) =>
      f.replace(/-/g, '_'),
    ),
  )
  const sampling = new Set(m.supported_sampling_parameters ?? [])

  // Modalities only when the row lists them outright. A lone image/vision
  // boolean does not say what else the model takes or emits.
  const modalities: ModelFacts['modalities'] =
    m.input_modalities || m.output_modalities
      ? { input: m.input_modalities ?? [], output: m.output_modalities ?? [] }
      : null

  const caps: Array<string> = []
  if (
    features.has('tools') ||
    features.has('function_calling') ||
    m.supports_tools ||
    flags.function_calling
  ) {
    caps.push('tools')
  }
  if (features.has('tool_choice')) caps.push('tool_choice')
  if (features.has('reasoning') || m.supports_reasoning || flags.reasoning) {
    caps.push('reasoning')
  }
  for (const param of ['temperature', 'top_p', 'top_k']) {
    if (sampling.has(param)) caps.push(param)
  }
  const structured =
    features.has('structured_outputs') || features.has('json_schema')
  if (structured) caps.push('structured_outputs')
  if (structured || features.has('json_mode')) caps.push('response_format')

  const facts: Partial<ModelFacts> = {}
  const contextWindow = positive(
    m.context_window ??
      m.context_length ??
      m.max_context_length ??
      m.context_size,
  )
  const maxOutput = positive(
    m.max_completion_tokens ?? m.max_output_length ?? m.max_output_tokens,
  )
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
  /** Per-row activity when the listing states it (issue #72). */
  activity?: (m: OpenAiCompatModelRow) => Activity | null
  /** Canonical id when the row is an alias (`ModelInfo.aliasOf`). */
  aliasOf?: (m: OpenAiCompatModelRow) => string | undefined
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
        ...(opts.activity ? { activity: opts.activity(m) } : {}),
        ...(opts.aliasOf?.(m) ? { aliasOf: opts.aliasOf(m) } : {}),
        ...openAiCompatModelFacts(m),
      })),
  }
}
