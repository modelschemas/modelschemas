/**
 * OpenRouter — public OpenAPI 3.1 spec at openrouter.ai/openapi.json, plus
 * the public GET /api/v1/videos/models metadata API. The fetcher synthesises
 * one constrained VideoGenerationRequest variant per video model (PR #622),
 * mounted at `/videos/{model-id}` so the rest of the pipeline treats each
 * model like any other endpoint. Fully keyless.
 */
import type { Activity } from '#/db/schema.ts'
import { fetchJson, fetchText } from './types.ts'
import type {
  ListModelsResult,
  OpenApiDocument,
  OpenApiOperation,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from './types.ts'

const OPENROUTER_OPENAPI_URL = 'https://openrouter.ai/openapi.json'
const OPENROUTER_VIDEO_MODELS_URL = 'https://openrouter.ai/api/v1/videos/models'
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models'

export const SYNTHETIC_VIDEO_MARKER = 'x-modelschemas-synthetic-video-model'

interface VideoModel {
  id: string
  name: string
  description?: string | null
  supported_resolutions?: Array<string> | null
  supported_aspect_ratios?: Array<string> | null
  supported_sizes?: Array<string> | null
  supported_durations?: Array<number> | null
  supported_frame_images?: Array<string> | null
  generate_audio?: boolean | null
  seed?: boolean | null
  allowed_passthrough_parameters?: Array<string> | null
}

/**
 * Path rules — OpenRouter's generation surface spans the OpenAI-compatible
 * endpoints and the Anthropic-compatible /messages. Account management
 * (auth/keys, byok, credits, guardrails, workspaces, observability),
 * preset-scoped variants, and rerank classify to null. Synthetic per-model
 * video paths carry SYNTHETIC_VIDEO_MARKER on their POST operation — that,
 * not the path shape, routes them to `video`, so real upstream additions
 * under /videos/* never classify by accident.
 */
function classify(path: string, op: OpenApiOperation): Activity | null {
  if (
    path === '/chat/completions' ||
    path === '/messages' ||
    path === '/responses'
  ) {
    return 'chat'
  }
  if (path.startsWith('/audio/')) return 'audio'
  if (path === '/videos' || SYNTHETIC_VIDEO_MARKER in op) return 'video'
  if (path === '/embeddings') return 'embeddings'
  return null
}

/**
 * OpenRouter declares the /embeddings request/response schemas inline rather
 * than via $ref; lift them into components.schemas under stable names so the
 * bundler can treat them like every other endpoint body.
 */
export function liftEmbeddingsSchemas(spec: OpenApiDocument): void {
  const post = spec.paths?.['/embeddings']?.post as
    | {
        requestBody?: {
          content?: Record<string, { schema?: Record<string, unknown> }>
        }
        responses?: Record<
          string,
          { content?: Record<string, { schema?: Record<string, unknown> }> }
        >
      }
    | undefined
  const schemas = spec.components?.schemas
  if (!post || !schemas) return

  const requestContent = post.requestBody?.content?.['application/json']
  if (requestContent?.schema && !('$ref' in requestContent.schema)) {
    schemas.EmbeddingsRequest = requestContent.schema
    requestContent.schema = { $ref: '#/components/schemas/EmbeddingsRequest' }
  }

  const responseContent = post.responses?.['200']?.content?.['application/json']
  if (responseContent?.schema && !('$ref' in responseContent.schema)) {
    schemas.EmbeddingsResponse = responseContent.schema
    responseContent.schema = {
      $ref: '#/components/schemas/EmbeddingsResponse',
    }
  }
}

function toPascal(id: string): string {
  return id
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join('')
}

/**
 * Synthesise one constrained VideoGenerationRequest variant per video model.
 * Field-level constraints (durations, resolutions, aspect ratios, sizes)
 * become enums; capabilities a model lacks (generate_audio, seed,
 * frame_images) drop out of its variant; cross-field rules the metadata
 * can't express structurally land in field descriptions.
 */
export function synthesizeVideoModelEndpoints(
  spec: OpenApiDocument,
  models: Array<VideoModel>,
): void {
  const basePost = spec.paths?.['/videos']?.post as
    | { responses?: unknown }
    | undefined
  const baseRequest = spec.components?.schemas?.VideoGenerationRequest
  if (!basePost || !baseRequest || !spec.paths) return

  for (const model of models) {
    const schemaName = `VideoGenerationRequest${toPascal(model.id)}`
    const schema = structuredClone(baseRequest) as {
      description?: string
      properties: Record<string, Record<string, unknown>>
    }
    const props = schema.properties

    schema.description = [
      `${model.name} (${model.id}) — model-constrained video generation request.`,
      model.description?.trim(),
    ]
      .filter(Boolean)
      .join(' ')

    props.model = {
      type: 'string',
      enum: [model.id],
      description: 'Model id (fixed for this model-constrained schema)',
    }
    if (model.supported_durations?.length) {
      props.duration = { ...props.duration, enum: model.supported_durations }
    }
    if (model.supported_resolutions?.length) {
      props.resolution = {
        ...props.resolution,
        enum: model.supported_resolutions,
      }
    }
    if (model.supported_aspect_ratios?.length) {
      props.aspect_ratio = {
        ...props.aspect_ratio,
        enum: model.supported_aspect_ratios,
      }
    }
    if (model.supported_sizes?.length) {
      props.size = { ...props.size, enum: model.supported_sizes }
    }
    if (model.generate_audio !== true) delete props.generate_audio
    if (model.seed !== true) delete props.seed
    if (model.supported_frame_images?.length) {
      props.frame_images = {
        ...props.frame_images,
        description:
          `${String(props.frame_images?.description ?? '')} Frame types supported by this model: ${model.supported_frame_images.join(', ')}.`.trim(),
      }
    } else {
      delete props.frame_images
    }
    if (model.allowed_passthrough_parameters?.length && props.provider) {
      props.provider = {
        ...props.provider,
        description:
          `${String(props.provider.description ?? '')} Passthrough parameters allowed for this model: ${model.allowed_passthrough_parameters.join(', ')}.`.trim(),
      }
    }

    spec.components ??= { schemas: {} }
    spec.components.schemas ??= {}
    spec.components.schemas[schemaName] = schema
    spec.paths[`/videos/${model.id}`] = {
      post: {
        [SYNTHETIC_VIDEO_MARKER]: model.id,
        operationId: `createVideo${toPascal(model.id)}`,
        summary: `Generate a video with ${model.name}`,
        requestBody: {
          content: {
            'application/json': {
              schema: { $ref: `#/components/schemas/${schemaName}` },
            },
          },
          required: true,
        },
        responses: structuredClone(basePost.responses),
      },
    }
  }
}

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  // The spec's key-management examples embed realistic-looking `sk-or-v1-…`
  // keys; redact them (they only appear in platform endpoints that classify
  // to null anyway).
  const text = (await fetchText(OPENROUTER_OPENAPI_URL)).replace(
    /sk-or-v1-[0-9a-f]{16,}/g,
    'sk-or-v1-REDACTED',
  )
  const spec = JSON.parse(text) as OpenApiDocument

  liftEmbeddingsSchemas(spec)

  let videoModels: Array<VideoModel> = []
  try {
    videoModels = (
      (await fetchJson(OPENROUTER_VIDEO_MODELS_URL)) as {
        data: Array<VideoModel>
      }
    ).data
    videoModels.sort((a, b) => a.id.localeCompare(b.id))
  } catch {
    // Metadata fetch failed — the generic /videos endpoint still works;
    // only the per-model variants are skipped this sync.
  }
  synthesizeVideoModelEndpoints(spec, videoModels)

  return { specs: [spec], outputStrategy: 'post-200' }
}

interface OpenRouterModelList {
  data?: Array<{
    id: string
    name?: string
    context_length?: number
    pricing?: unknown
    architecture?: {
      input_modalities?: Array<string>
      output_modalities?: Array<string>
    }
    supported_parameters?: Array<string>
    top_provider?: { max_completion_tokens?: number | null }
  }>
}

async function listModels(_env: ProviderSecrets): Promise<ListModelsResult> {
  const body = (await fetchJson(OPENROUTER_MODELS_URL)) as OpenRouterModelList
  return {
    models: (body.data ?? []).map((m) => ({
      rawId: m.id,
      displayName: m.name ?? null,
      contextWindow: m.context_length ?? null,
      maxOutput: m.top_provider?.max_completion_tokens ?? null,
      pricing: m.pricing,
      modalities: m.architecture
        ? {
            input: m.architecture.input_modalities,
            output: m.architecture.output_modalities,
          }
        : undefined,
      capabilities: m.supported_parameters,
    })),
  }
}

export const openrouterProvider: ProviderConfig = {
  id: 'openrouter',
  displayName: 'OpenRouter',
  fetchSpec,
  listModels,
  classify,
}
