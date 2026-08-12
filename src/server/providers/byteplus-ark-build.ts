/**
 * Builds the BytePlus Ark OpenAPI document from BytePlus's own Go SDK at sync
 * time, so the spec tracks upstream SDK releases instead of being frozen at
 * whatever was hand-ported.
 *
 * `service/arkruntime/model/*.go` declares the whole Ark data plane as structs
 * with `json:"…"` tags; `go-struct-parser.ts` turns those into component
 * schemas, and this module maps them onto HTTP paths and re-applies the
 * curated knowledge the SDK cannot express.
 *
 * **Two things the SDK does not carry**, both preserved here rather than
 * regressed away:
 *
 * 1. A handful of request fields Ark accepts that the Go structs omit
 *    (`reasoning_effort`, `top_k` and `seed` on chat; `stream` on images;
 *    `output_format` on video). These are listed explicitly in
 *    {@link ARK_CURATED_PROPERTIES} — an explicit list, not a blanket merge of
 *    the old static document, so that a field genuinely REMOVED upstream
 *    disappears from our spec instead of being resurrected forever.
 * 2. Field descriptions. Go doc comments are sparse, while the hand-written
 *    ones carry probe findings that matter to callers (Seedream's `watermark`
 *    defaults to true, generated URLs expire in 24h, `max_tokens` and
 *    `max_completion_tokens` are mutually exclusive, …). Curated descriptions
 *    win wherever they exist.
 *
 * Endpoint→type mapping is hand-maintained: the SDK's model package has no
 * notion of HTTP paths (those are consts over in the client package), and
 * which struct serves which route is not mechanically derivable. Paths change
 * rarely; field sets change often — so the rarely-changing half is pinned and
 * the fast-moving half is generated.
 */
import { parseGoSchemas } from './go-struct-parser.ts'
import type { GoSourceFile, JsonSchema } from './go-struct-parser.ts'
import type { OpenApiDocument } from './types.ts'

export const BYTEPLUS_ARK_BASE_URL =
  'https://ark.ap-southeast.bytepluses.com/api/v3'

/** Default branch of `byteplus-sdk/byteplus-go-sdk-v2`. */
const GO_SDK_REF = 'main'
const GO_SDK_REPO = 'byteplus-sdk/byteplus-go-sdk-v2'
const GO_MODEL_DIR = 'service/arkruntime/model'

/**
 * The model-package files reachable from our endpoint roots. Fetched in this
 * order; the provenance hash covers their concatenation.
 */
export const ARK_GO_FILES = [
  'chat_completion.go',
  'images.go',
  'content_generation.go',
  'common.go',
] as const

export function arkGoFileUrl(file: string): string {
  return `https://raw.githubusercontent.com/${GO_SDK_REPO}/${GO_SDK_REF}/${GO_MODEL_DIR}/${file}`
}

/** Human-facing provenance URL for the directory the schemas came from. */
export const ARK_GO_SOURCE_URL = `https://github.com/${GO_SDK_REPO}/tree/${GO_SDK_REF}/${GO_MODEL_DIR}`

interface ArkEndpoint {
  path: string
  operationId: string
  summary: string
  requestType: string
  responseType: string
  responseDescription: string
}

/**
 * `ChatCompletionRequest` (the legacy struct) is deliberately NOT used —
 * upstream marks it deprecated and it lacks `thinking`,
 * `parallel_tool_calls` and `max_completion_tokens`.
 */
const ARK_ENDPOINTS: Array<ArkEndpoint> = [
  {
    path: '/chat/completions',
    operationId: 'createChatCompletion',
    summary:
      'Chat completion (Seed / GLM / DeepSeek / gpt-oss) — OpenAI-compatible plus thinking, reasoning_effort, repetition_penalty and service_tier',
    requestType: 'CreateChatCompletionRequest',
    responseType: 'ChatCompletionResponse',
    responseDescription: 'Completion',
  },
  {
    path: '/images/generations',
    operationId: 'createImageGeneration',
    summary: 'Generate or edit images with Seedream',
    requestType: 'GenerateImagesRequest',
    responseType: 'ImagesResponse',
    responseDescription: 'Generated images',
  },
  {
    path: '/contents/generations/tasks',
    operationId: 'createContentsGenerationsTask',
    summary:
      'Open a Seedance video generation task (async — poll GET /contents/generations/tasks/{id} for the result)',
    requestType: 'CreateContentGenerationTaskRequest',
    responseType: 'CreateContentGenerationTaskResponse',
    responseDescription: 'Task acknowledgment',
  },
]

/**
 * Request fields Ark accepts that the Go SDK's structs do not declare, keyed
 * by the schema they belong to. All were exercised live by TanStack AI's
 * 2026-07-31 probe sweep; the SDK simply lags.
 */
const ARK_CURATED_PROPERTIES: Record<string, Record<string, JsonSchema>> = {
  CreateChatCompletionRequest: {
    reasoning_effort: {
      type: 'string',
      enum: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      description:
        "Reasoning budget hint. 'none' and 'xhigh' are only accepted by glm-5-2-260617; 'max' by glm-5-2-260617 and the deepseek-v4-* models. Rejected in combination with thinking: {type: 'disabled'}. Absent from the Go SDK; probe-verified 2026-07-31.",
    },
    top_k: {
      type: 'integer',
      description:
        'Restricts sampling to the k most likely tokens. Absent from the Go SDK; probe-verified 2026-07-31.',
    },
    seed: {
      type: 'integer',
      description:
        'Best-effort determinism hint for repeated identical requests. Absent from the Go SDK; probe-verified 2026-07-31.',
    },
  },
  GenerateImagesRequest: {
    stream: {
      type: 'boolean',
      description:
        'Server-sent-events mode, emitting each image as it finishes. Absent from the Go SDK request struct, which models the unary call only.',
    },
  },
  CreateContentGenerationTaskRequest: {
    output_format: {
      type: 'string',
      description:
        'Container of the generated video, e.g. mp4 or mov. Absent from the Go SDK request struct but returned on the task record and accepted on create.',
    },
  },
}

/**
 * Curated field descriptions, keyed by schema then wire field name. These
 * carry behaviour a type declaration cannot state, so they override the Go
 * doc comment whenever both exist.
 */
const ARK_CURATED_DESCRIPTIONS: Record<string, Record<string, string>> = {
  CreateChatCompletionRequest: {
    model:
      'Ark model id (e.g. seed-2-0-lite-260428) or a preconfigured endpoint id.',
    max_tokens:
      'Maximum tokens to generate. Mutually exclusive with max_completion_tokens — sending both is a 400.',
    max_completion_tokens:
      "OpenAI's newer name for max_tokens; mutually exclusive with it.",
    repetition_penalty:
      'Penalty applied to repeated tokens. Values above 1 discourage repetition.',
    service_tier:
      "'flex' routes to the batch queue at a lower price with no latency guarantee; 'default' is the standard online tier.",
    thinking:
      "Reasoning ('deep thinking') switch. 'enabled' is the default on every model except deepseek-v3-2-251201; 'auto' is only accepted by gpt-oss-120b-250805. Cannot be combined with reasoning_effort when disabled (400 InvalidParameter).",
    response_format:
      "Structured output. Only {type: 'json_schema'} works, and only on a subset of models — Ark's own features.structured_outputs flag is unreliable (seed-2-0-lite-260428 advertises support and then 400s). Probe-verified accepting: dola-seed-2-1-turbo-260628, seed-2-0-pro-260328, seed-2-0-lite-260228, seed-2-0-mini-260215, seed-1-8-251228, the seed-1-6 family, glm-5-2-260617.",
    stop: 'Up to four strings that stop generation when produced.',
    user: 'Opaque end-user identifier forwarded for abuse monitoring.',
  },
  GenerateImagesRequest: {
    model:
      'Seedream model id (e.g. seedream-4-0-250828) or a preconfigured endpoint id.',
    prompt: 'Instruction text (docs give the limit as 600 English words).',
    image:
      'Input images for image-conditioned generation (editing, reference-guided generation, multi-reference composition). Each entry is a publicly reachable URL or a data:image/<format>;base64,<data> URI — <format> must be lowercase. Up to 14 references (10 on dola-seedream-5-0-pro-260628).',
    size: "Output size: a shorthand token ('1K', '2K', '4K') or explicit pixels ('2048x2048') — never a mix. Server default 2048x2048.",
    response_format:
      "How generated images come back. 'url' links expire 24 hours after generation. Server default 'url'.",
    output_format:
      "Generated file format. Seedream 5.0 family only; default 'jpeg'.",
    watermark:
      "Stamp an 'AI generated' watermark in the bottom-right corner. DEFAULTS TO TRUE — pass false to opt out.",
    sequential_image_generation:
      "Group-image mode: 'auto' lets the model return a set of related images (bounded by sequential_image_generation_options.max_images — an upper bound, not a count); 'disabled' (server default) returns exactly one.",
    guidance_scale:
      'How strictly the result follows the prompt; higher values adhere more closely at some cost to diversity.',
    tools:
      'Provider tools to run during generation; the only documented member is web search, whose usage comes back under usage.tool_usage.web_search.',
  },
  CreateContentGenerationTaskRequest: {
    model:
      'Seedance model id (e.g. seedance-1-5-pro-251215; the 2.0 family requires the dreamina- prefix) or a preconfigured endpoint id.',
    ratio:
      "Output aspect ratio: 16:9, 9:16, 4:3, 3:4, 1:1, 21:9, or 'adaptive' (follows the input frame; image-to-video only).",
    resolution:
      'Resolution tier: 480p/720p on Seedance 2.5 and 2.0-fast/-mini, up to 1080p on the 1.x models and 4k on dreamina-seedance-2-0-260128. Matched case-insensitively by the API; there is no 2K tier on any model.',
    duration:
      'Whole seconds of output (2-12s on 1.0, 4-12s on 1.5-pro, 4-15s on 2.0, 4-30s on 2.5). -1 lets the model choose (2.5 / 2.0 / 1.5-pro).',
    frames:
      'Frame count, an alternative to duration that allows fractional seconds.',
    seed: 'Randomness seed; integers in [-1, 2^32-1], where -1 means unseeded.',
    camera_fixed:
      "Appends a 'fix the camera' instruction to the prompt. Default false.",
    watermark: 'Burn a watermark into the output. Default false.',
    generate_audio: 'Generate a synchronized audio track. Default false.',
    service_tier:
      "'default' (online) or 'flex' (offline batch, half price). Note flex tasks are missing from the default task listing unless filter.service_tier=flex is passed.",
    return_last_frame: 'Also return the final frame as a PNG. Default false.',
    draft: 'Cheap low-fidelity preview render. Default false.',
    content:
      'Prompt text plus image / video / audio inputs. The API sorts requests into task types from the roles present — i2v (first frame), flf2v (first + last frame) and r2v (reference media) — and the two families are mutually exclusive.',
    safety_identifier:
      'Opaque per-end-user identifier for abuse attribution, max 64 chars.',
    execution_expires_after:
      "Seconds from created_at after which the task is marked 'expired'.",
    callback_url:
      'URL that receives a POST with the task payload on each status change.',
  },
  CreateContentGenerationTaskResponse: {
    id: 'Task id, e.g. cgt-batch-20260731174311-zmz5s — the -batch infix appears on flex-tier routing. Poll GET /contents/generations/tasks/{id} until the status is terminal; the video URL arrives with the succeeded status and expires 24 hours later (the task record itself is kept for 7 days).',
  },
}

/** Apply curated extra properties and descriptions to a generated schema. */
function applyCurated(name: string, schema: JsonSchema): JsonSchema {
  const extras = ARK_CURATED_PROPERTIES[name]
  const descriptions = ARK_CURATED_DESCRIPTIONS[name]
  if (!extras && !descriptions) return schema

  const properties = {
    ...(schema.properties as Record<string, JsonSchema> | undefined),
  }
  for (const [field, spec] of Object.entries(extras ?? {})) {
    // Curated extras never clobber a field the SDK now declares — if upstream
    // has caught up, upstream wins on shape.
    properties[field] ??= spec
  }
  for (const [field, description] of Object.entries(descriptions ?? {})) {
    const existing = properties[field]
    if (existing) properties[field] = { ...existing, description }
  }
  return { ...schema, properties }
}

export interface ArkSpecBuild {
  spec: OpenApiDocument
  warnings: Array<string>
}

/**
 * Build the Ark document from fetched Go sources. Throws only if the sources
 * are unusable (no endpoint root parsed) so the caller can fall back to the
 * embedded document.
 */
export function buildArkSpecFromGo(files: Array<GoSourceFile>): ArkSpecBuild {
  const roots = ARK_ENDPOINTS.flatMap((e) => [e.requestType, e.responseType])
  const { schemas, warnings } = parseGoSchemas(files, roots)

  const missing = roots.filter((r) => !(r in schemas))
  if (missing.length > 0) {
    throw new Error(
      `byteplus: Go SDK parse missing endpoint types: ${missing.join(', ')}`,
    )
  }

  const components: Record<string, JsonSchema> = {}
  for (const [name, schema] of Object.entries(schemas)) {
    components[name] = applyCurated(name, schema)
  }

  const paths: NonNullable<OpenApiDocument['paths']> = {}
  for (const endpoint of ARK_ENDPOINTS) {
    paths[endpoint.path] = {
      post: {
        operationId: endpoint.operationId,
        summary: endpoint.summary,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: `#/components/schemas/${endpoint.requestType}` },
            },
          },
        },
        responses: {
          '200': {
            description: endpoint.responseDescription,
            content: {
              'application/json': {
                schema: {
                  $ref: `#/components/schemas/${endpoint.responseType}`,
                },
              },
            },
          },
        },
      },
    }
  }

  return {
    spec: {
      openapi: '3.1.0',
      info: {
        title: 'BytePlus ModelArk API',
        version: 'v3',
        description: `Generated at sync time from BytePlus's official Go SDK (${ARK_GO_SOURCE_URL}), with curated descriptions and the request fields the SDK omits re-applied. Auth: Authorization: Bearer $ARK_API_KEY; keys are region-isolated.`,
      },
      servers: [{ url: BYTEPLUS_ARK_BASE_URL }],
      paths,
      components: { schemas: components },
    },
    warnings,
  }
}
