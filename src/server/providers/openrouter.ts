/**
 * OpenRouter — public OpenAPI 3.1 spec at openrouter.ai/openapi.json, plus
 * the public GET /api/v1/videos/models metadata API. The fetcher synthesises
 * one constrained VideoGenerationRequest variant per video model (PR #622),
 * mounted at `/videos/{model-id}` so the rest of the pipeline treats each
 * model like any other endpoint. Fully keyless.
 */
import type { Activity } from '#/db/schema.ts'
import { bearerConnect } from './connect.ts'
import {
  openrouterGenerationEndpointId,
  openrouterModelActivity,
} from './model-meta.ts'
import {
  cachedDocs,
  docsReport,
  docsRun,
  tryDocs,
  unavailable,
} from './model-facts.ts'
import {
  OPENROUTER_ADAPTIVE_GUIDES,
  openRouterAdaptiveGuide,
  openRouterGatewayEfforts,
  openRouterGatewayToggle,
  openRouterGatewayEffortWire,
  statesAdaptive,
  OPENROUTER_REASONING_URL,
} from './openrouter-reasoning.ts'
import { openRouterReasoning } from './reasoning-config.ts'
import { blank } from './request-map.ts'
import { namespacedUpstreamIdentity } from './upstream-model.ts'
import { fetchJson, fetchText, sha256Text } from './types.ts'
import type {
  ListModelsResult,
  ModelReasoning,
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
  const rawText = await fetchText(OPENROUTER_OPENAPI_URL)
  // Provenance hashes the bytes as served (curl-reproducible) — before the
  // redaction below.
  const source = {
    url: OPENROUTER_OPENAPI_URL,
    hash: await sha256Text(rawText),
  }
  // The spec's key-management examples embed realistic-looking `sk-or-v1-…`
  // keys; redact them (they only appear in platform endpoints that classify
  // to null anyway).
  const text = rawText.replace(/sk-or-v1-[0-9a-f]{16,}/g, 'sk-or-v1-REDACTED')
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

  return { specs: [spec], sources: [source], outputStrategy: 'post-200' }
}

interface OpenRouterModelList {
  data?: Array<{
    id: string
    name?: string
    created?: number
    context_length?: number
    pricing?: unknown
    architecture?: {
      input_modalities?: Array<string>
      output_modalities?: Array<string>
    }
    supported_parameters?: Array<string>
    top_provider?: { max_completion_tokens?: number | null }
    reasoning?: {
      supported_efforts?: Array<string | null> | null
      mandatory?: boolean
      supports_max_tokens?: boolean
    } | null
  }>
}

/**
 * Tool type ids are router-level. `supported_parameters` includes `tools`
 * for client function calling and is not a hosted tool id. A listing that
 * does not name per-model type ids stays null (issue #123).
 */
export function openrouterServerTools(_model: {
  supported_parameters?: Array<string>
}): null {
  return null
}

/** Validate native metadata before deriving capability independently of mode. */
export function openrouterCapabilities(model: {
  supported_parameters?: unknown
  reasoning?: unknown
}): Array<string> | undefined {
  const parameters = model.supported_parameters
  if (
    parameters !== undefined &&
    (!Array.isArray(parameters) ||
      !parameters.every(
        (value) => typeof value === 'string' && value.length > 0,
      ))
  )
    throw new Error('openrouter: unreadable supported_parameters')
  const reasoning = model.reasoning
  if (
    reasoning !== undefined &&
    reasoning !== null &&
    (typeof reasoning !== 'object' || Array.isArray(reasoning))
  )
    throw new Error('openrouter: unreadable native reasoning metadata')
  return reasoning && typeof reasoning === 'object'
    ? [
        ...new Set([
          ...((parameters as Array<string> | undefined) ?? []),
          'reasoning',
        ]),
      ]
    : (parameters as Array<string> | undefined)
}

async function listModels(
  _env: ProviderSecrets,
  kv?: KVNamespace,
): Promise<ListModelsResult> {
  const body = (await fetchJson(OPENROUTER_MODELS_URL)) as OpenRouterModelList
  if (!Array.isArray(body.data) || !body.data.length)
    throw new Error('openrouter: missing or empty native model catalog')
  const needsToggle = body.data.some((m) => m.reasoning?.mandatory === false)
  const needsEffortWire = body.data.some(
    (m) =>
      typeof m.reasoning?.mandatory === 'boolean' &&
      Array.isArray(m.reasoning.supported_efforts) &&
      m.reasoning.supported_efforts.includes('high'),
  )
  const gatewayLoad =
    needsToggle ||
    needsEffortWire ||
    body.data.some(
      (m) =>
        m.reasoning?.supported_efforts === null &&
        typeof m.reasoning.mandatory === 'boolean',
    )
      ? cachedDocs(
          kv,
          `${OPENROUTER_REASONING_URL}#${needsToggle ? 'gateway-efforts-and-toggle-wire-v1' : 'gateway-efforts-wire-v1'}`,
          async () => {
            const text = await fetchText(OPENROUTER_REASONING_URL, {
              signal: AbortSignal.timeout(30_000),
            })
            return {
              efforts: openRouterGatewayEfforts(text),
              effortWire: openRouterGatewayEffortWire(text),
              toggle: needsToggle ? openRouterGatewayToggle(text) : undefined,
              hash: await sha256Text(text),
            }
          },
        )
      : null
  const run = docsRun()
  const listed = new Set(body.data.map((m) => openRouterAdaptiveGuide(m.id)))
  const adaptiveLoad = Promise.all(
    OPENROUTER_ADAPTIVE_GUIDES.filter((guide) => listed.has(guide)).map(
      async (guide) =>
        [
          guide.url,
          await tryDocs(run, guide.url, (cached) =>
            cached(kv, `${guide.url}#adaptive-v1`, async () => {
              const text = await fetchText(guide.url, {
                signal: AbortSignal.timeout(30_000),
              })
              if (!statesAdaptive(text, guide))
                throw new Error(
                  'openrouter: adaptive thinking statement missing',
                )
              return { hash: await sha256Text(text) }
            }),
          ),
        ] as const,
    ),
  )
  const [gateway, guides] = await Promise.all([gatewayLoad, adaptiveLoad])
  const adaptive = new Map(guides)
  const ownThinking = (reason: ModelReasoning | null) => {
    if (reason?.mode === 'toggle') return gateway?.toggle ?? null
    const high = reason?.efforts?.find((e) => e === 'high')
    if (reason?.mode === 'effort' && high && gateway?.effortWire)
      return {
        on: {
          [gateway.effortWire.outer]: { [gateway.effortWire.field]: high },
        },
        off: reason.mandatory === false ? (gateway.toggle?.off ?? null) : null,
        levels: null,
      }
    return null
  }
  // The guide states the mode; the listing states mandatory and efforts.
  // A guided row keeps its stored reasoning (`unavailable`) when its guide
  // failed to load or its listing no longer reads as per-model efforts.
  const adaptiveReasoning = (
    rawId: string,
    reasoning: ModelReasoning | null,
  ) => {
    const guide = openRouterAdaptiveGuide(rawId)
    if (!guide) return null
    const doc = adaptive.get(guide.url)
    if (!doc || reasoning?.mode !== 'effort') return 'unavailable' as const
    return {
      reasoning: { ...reasoning, mode: 'adaptive' as const },
      source: {
        derivation: 'docs-derived' as const,
        sourceUrl: guide.url,
        sourceHash: doc.hash,
        path: 'adaptive thinking statement; listing reasoning.mandatory and supported_efforts',
      },
    }
  }
  return {
    docsFailures: docsReport(run),
    models: body.data.map((m) => {
      const listedReasoning = openRouterReasoning(
        m,
        gateway?.efforts,
        gateway?.toggle !== undefined,
      )
      const adapted = adaptiveReasoning(m.id, listedReasoning)
      const thinking = ownThinking(listedReasoning)
      const gatewayDoc =
        gateway &&
        (m.reasoning?.supported_efforts === null || thinking !== null) &&
        typeof m.reasoning?.mandatory === 'boolean'
          ? gateway
          : null
      const reasoningSource =
        adapted && adapted !== 'unavailable'
          ? adapted.source
          : gatewayDoc && {
              derivation: 'docs-derived' as const,
              sourceUrl: OPENROUTER_REASONING_URL,
              sourceHash: gatewayDoc.hash,
              path:
                m.reasoning?.supported_efforts === null
                  ? 'supported_efforts:null; normative gateway effort bullets; listing mandatory'
                  : listedReasoning?.mode === 'toggle'
                    ? 'native mandatory:false; Messages API normalized reasoning.enabled accepted on every reasoning model; explicit disables prose'
                    : 'native per-model accepted efforts and mandatory metadata; universal normalized reasoning.effort field',
            }
      return {
        rawId: m.id,
        displayName: m.name ?? null,
        activity: openrouterModelActivity(m.architecture?.output_modalities),
        releasedAt: m.created ?? null,
        contextWindow: m.context_length ?? null,
        maxOutput: m.top_provider?.max_completion_tokens ?? null,
        pricing: m.pricing,
        modalities: m.architecture
          ? {
              input: m.architecture.input_modalities,
              output: m.architecture.output_modalities,
            }
          : undefined,
        capabilities: openrouterCapabilities(m),
        requestMap: thinking ? blank({ thinking }) : null,
        reasoning:
          adapted && adapted !== 'unavailable'
            ? adapted.reasoning
            : listedReasoning,
        ...(adapted === 'unavailable' ? unavailable('reasoning') : {}),
        ...(reasoningSource
          ? {
              factSources: {
                ...(gatewayDoc && thinking
                  ? {
                      requestMapFields: {
                        thinking: {
                          derivation: 'docs-derived' as const,
                          sourceUrl: OPENROUTER_REASONING_URL,
                          sourceHash: gatewayDoc.hash,
                          path: 'native accepted effort values or nonmandatory toggle; normative universal normalized reasoning effort/enabled fields',
                        },
                      },
                    }
                  : {}),
                reasoning: reasoningSource,
              },
            }
          : {}),
      }
    }),
  }
}

export const openrouterProvider: ProviderConfig = {
  id: 'openrouter',
  upstreamModelIdentity: (rawId) =>
    namespacedUpstreamIdentity(rawId, {
      derivation: 'listing',
      sourceUrl: OPENROUTER_MODELS_URL,
      path: 'data[].id',
    }),
  displayName: 'OpenRouter',
  defaultDerivation: 'upstream-spec',
  specGrain: 'provider',
  // The shared gateway schema describes an available parameter, not support by every model.
  perModelSchemaFlags: ['reasoning'],
  connect: bearerConnect('https://openrouter.ai/api/v1'),
  fetchSpec,
  listModels,
  classify,
  generationEndpointId: ({ rawId, activity }) =>
    openrouterGenerationEndpointId(rawId, activity),
}
