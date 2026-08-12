/**
 * BytePlus — synthesized OpenAPI documents. BytePlus publishes no public
 * machine-readable spec (its OpenAPI documents live behind the console's API
 * explorer), so the generation surface is embedded here, ported from
 * TanStack AI's `@tanstack/ai-byteplus` wire types
 * (`packages/ai-byteplus/src/{video,image,audio}/wire-types.ts`,
 * `message-types.ts`, `text/text-provider-options.ts`), which record their
 * provenance field-by-field: harvested OpenAPI 3.1 documents for the `ark`
 * service plus live probes against the ap-southeast host on 2026-07-31.
 *
 * Cross-checked 2026-08-12 against BytePlus's own international SDKs
 * (`github.com/byteplus-sdk/byteplus-go-sdk-v2` v1.0.32
 * `service/arkruntime/model`, ~1,100 json-tagged fields; the same shapes back
 * `byteplus-python-sdk-v2` and `byteplus-java-sdk-v2-ark-runtime`). Fields
 * that exist only in those SDKs are marked SDK-derived at their declaration.
 * The SDKs cover Ark only — Seed Speech appears in none of them, so the voice
 * document below remains docs-derived.
 *
 * Two hosts, two products, two API keys:
 * - **Ark (ModelArk)** — chat (`/chat/completions`, OpenAI-compatible),
 *   Seedance video (`/contents/generations/tasks`, async task API) and
 *   Seedream image (`/images/generations`). `Authorization: Bearer
 *   $ARK_API_KEY`; keys are region-isolated (an ap-southeast key does not
 *   work against the EU host).
 * - **Seed Speech** — TTS (`/tts/create`) and ASR
 *   (`/auc/bigmodel/recognize/flash`) on the voice host, authenticated with
 *   `X-Api-Key: $BYTEPLUS_VOICE_API_KEY` (an Ark key there fails with
 *   `45000010 Invalid X-Api-Key`).
 *
 * Each spec is built fresh per call so sync-time consumers can never
 * accidentally share (or mutate) module-scoped state across requests.
 */
import type { OpenApiDocument } from './types.ts'

export const BYTEPLUS_ARK_BASE_URL =
  'https://ark.ap-southeast.bytepluses.com/api/v3'
export const BYTEPLUS_VOICE_BASE_URL =
  'https://voice.ap-southeast-1.bytepluses.com/api/v3'

/** Human docs the embedded documents were derived from (provenance URLs). */
export const BYTEPLUS_ARK_DOCS_URL =
  'https://docs.byteplus.com/en/docs/ModelArk'
export const BYTEPLUS_VOICE_DOCS_URL =
  'https://docs.byteplus.com/en/docs/byteplusvoice'

type Schema = Record<string, unknown>

// ---------------------------------------------------------------------------
// Chat (/chat/completions — OpenAI-compatible plus Ark-only extensions)
// ---------------------------------------------------------------------------

const chatContentPartSchemas: Record<string, Schema> = {
  ChatTextContentPart: {
    type: 'object',
    description: 'Plain text content part.',
    properties: {
      type: { type: 'string', enum: ['text'] },
      text: { type: 'string' },
    },
    required: ['type', 'text'],
  },
  ChatImageContentPart: {
    type: 'object',
    description:
      "Image content part. Ark extends OpenAI's image_url with an 'xhigh' detail level and image_pixel_limit bounds.",
    properties: {
      type: { type: 'string', enum: ['image_url'] },
      image_url: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'Public image URL or data: URI.',
          },
          detail: {
            type: 'string',
            enum: ['auto', 'low', 'high', 'xhigh'],
            description:
              "Processing detail. Ark adds 'xhigh' to OpenAI's set. Default 'auto'.",
          },
          image_pixel_limit: {
            type: 'object',
            description:
              'Bounds on how large the image is scaled to before tokenization. Lower max_pixels trades detail for input tokens; a min_pixels below the model floor is rejected.',
            properties: {
              max_pixels: { type: 'integer' },
              min_pixels: { type: 'integer' },
            },
          },
        },
        required: ['url'],
      },
    },
    required: ['type', 'image_url'],
  },
  ChatVideoContentPart: {
    type: 'object',
    description:
      'Video content part (no OpenAI equivalent). Accepts a public URL or a data: URI.',
    properties: {
      type: { type: 'string', enum: ['video_url'] },
      video_url: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          fps: {
            type: 'number',
            description: 'Frame sampling rate in frames per second.',
          },
        },
        required: ['url'],
      },
    },
    required: ['type', 'video_url'],
  },
  ChatInputAudioContentPart: {
    type: 'object',
    description:
      "Audio content part. Ark extends OpenAI's input_audio (inline base64 + format) with a url alternative; data and url are mutually exclusive.",
    properties: {
      type: { type: 'string', enum: ['input_audio'] },
      input_audio: {
        type: 'object',
        properties: {
          data: {
            type: 'string',
            description: 'Base64 audio payload. Mutually exclusive with url.',
          },
          format: {
            type: 'string',
            enum: ['wav', 'mp3', 'ogg', 'flac', 'm4a', 'aac', 'pcm'],
            description: 'Container format of data. Required when data is set.',
          },
          url: {
            type: 'string',
            description: 'Public audio URL. Mutually exclusive with data.',
          },
        },
      },
    },
    required: ['type', 'input_audio'],
  },
  ChatContentPart: {
    oneOf: [
      { $ref: '#/components/schemas/ChatTextContentPart' },
      { $ref: '#/components/schemas/ChatImageContentPart' },
      { $ref: '#/components/schemas/ChatVideoContentPart' },
      { $ref: '#/components/schemas/ChatInputAudioContentPart' },
    ],
  },
}

const chatSchemas: Record<string, Schema> = {
  ...chatContentPartSchemas,
  ChatToolCall: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      type: { type: 'string', enum: ['function'] },
      function: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          arguments: {
            type: 'string',
            description: 'JSON-encoded argument object.',
          },
        },
        required: ['name', 'arguments'],
      },
    },
    required: ['id', 'type', 'function'],
  },
  ChatMessage: {
    type: 'object',
    properties: {
      role: {
        type: 'string',
        enum: ['system', 'user', 'assistant', 'tool'],
      },
      content: {
        description:
          'Message text, or an array of multimodal content parts. Null on assistant turns that carry only tool_calls.',
        oneOf: [
          { type: 'string' },
          {
            type: 'array',
            items: { $ref: '#/components/schemas/ChatContentPart' },
          },
          { type: 'null' },
        ],
      },
      name: { type: 'string' },
      tool_calls: {
        type: 'array',
        items: { $ref: '#/components/schemas/ChatToolCall' },
        description: 'Tool calls issued by a prior assistant turn.',
      },
      tool_call_id: {
        type: 'string',
        description: "For role 'tool': id of the call this message answers.",
      },
      reasoning_content: {
        type: 'string',
        description:
          'Reasoning trace from a prior assistant turn, echoed back on multi-turn conversations.',
      },
      encrypted_content: {
        type: 'string',
        description:
          'Opaque signature blob emitted alongside reasoning_content by thinking-summary models (dola-seed-2-1-turbo, seed-2-0-lite/mini/pro-2604xx family). When present it should be echoed back verbatim on the assistant message in the next turn; omitting it is tolerated.',
      },
    },
    required: ['role'],
  },
  ChatTool: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['function'] },
      function: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          parameters: {
            type: 'object',
            description: 'JSON Schema of the function arguments.',
          },
        },
        required: ['name'],
      },
    },
    required: ['type', 'function'],
  },
  ChatToolChoice: {
    description:
      "Tool-selection strategy: 'none', 'auto', 'required', or a named function.",
    oneOf: [
      { type: 'string', enum: ['none', 'auto', 'required'] },
      {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['function'] },
          function: {
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name'],
          },
        },
        required: ['type', 'function'],
      },
    ],
  },
  ChatResponseFormat: {
    type: 'object',
    description:
      "Structured output. Only {type: 'json_schema'} works, and only on a subset of models (probed 2026-07-31: dola-seed-2-1-turbo-260628, seed-2-0-pro-260328, seed-2-0-lite-260228, seed-2-0-mini-260215, seed-1-8-251228, the seed-1-6 family, glm-5-2-260617). Ark rejects {type: 'json_object'} outright on every model, and glm-4-7-251222 accepts a json_schema but ignores it.",
    properties: {
      type: { type: 'string', enum: ['json_schema'] },
      json_schema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          schema: { type: 'object' },
          strict: { type: 'boolean' },
        },
        required: ['name', 'schema'],
      },
    },
    required: ['type', 'json_schema'],
  },
  ChatThinking: {
    type: 'object',
    description:
      "Reasoning ('deep thinking') switch. 'enabled' is the default on every model except deepseek-v3-2-251201; 'auto' is only accepted by gpt-oss-120b-250805. Cannot be combined with reasoning_effort when disabled (400 InvalidParameter).",
    properties: {
      type: { type: 'string', enum: ['enabled', 'disabled', 'auto'] },
    },
    required: ['type'],
  },
  ChatCompletionRequest: {
    type: 'object',
    description:
      'Ark chat completion request — OpenAI-compatible plus the Ark-only thinking, reasoning_effort, repetition_penalty and service_tier fields. Every field was accepted by a live request against the ap-southeast host on 2026-07-31.',
    properties: {
      model: {
        type: 'string',
        description:
          'Ark model id (e.g. seed-2-0-lite-260428) or a preconfigured endpoint id.',
      },
      messages: {
        type: 'array',
        items: { $ref: '#/components/schemas/ChatMessage' },
      },
      thinking: { $ref: '#/components/schemas/ChatThinking' },
      reasoning_effort: {
        type: 'string',
        enum: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
        description:
          "Reasoning budget hint. 'none' and 'xhigh' are only accepted by glm-5-2-260617; 'max' by glm-5-2-260617 and the deepseek-v4-* models. Rejected in combination with thinking: {type: 'disabled'}.",
      },
      repetition_penalty: {
        type: 'number',
        description:
          'Penalty applied to repeated tokens. Values above 1 discourage repetition.',
      },
      service_tier: {
        type: 'string',
        enum: ['default', 'flex'],
        description:
          "'flex' routes to the batch queue at a lower price with no latency guarantee.",
      },
      temperature: { type: 'number' },
      top_p: { type: 'number' },
      top_k: { type: 'integer' },
      max_tokens: {
        type: 'integer',
        description:
          'Maximum tokens to generate. Mutually exclusive with max_completion_tokens — sending both is a 400.',
      },
      max_completion_tokens: {
        type: 'integer',
        description:
          "OpenAI's newer name for max_tokens; mutually exclusive with it.",
      },
      frequency_penalty: { type: 'number' },
      presence_penalty: { type: 'number' },
      stop: {
        description: 'Up to four strings that stop generation when produced.',
        oneOf: [
          { type: 'string' },
          { type: 'array', items: { type: 'string' } },
        ],
      },
      n: { type: 'integer', description: 'Number of completions to generate.' },
      seed: {
        type: 'integer',
        description: 'Best-effort determinism hint for repeated requests.',
      },
      logprobs: { type: 'boolean' },
      top_logprobs: {
        type: 'integer',
        description: 'Alternatives to report per token. Requires logprobs.',
      },
      logit_bias: {
        type: 'object',
        additionalProperties: { type: 'number' },
        description: 'Additive bias per token id, applied before sampling.',
      },
      user: {
        type: 'string',
        description:
          'Opaque end-user identifier forwarded for abuse monitoring.',
      },
      parallel_tool_calls: { type: 'boolean' },
      tool_choice: { $ref: '#/components/schemas/ChatToolChoice' },
      tools: {
        type: 'array',
        items: { $ref: '#/components/schemas/ChatTool' },
      },
      response_format: { $ref: '#/components/schemas/ChatResponseFormat' },
      stream: { type: 'boolean' },
      stream_options: {
        type: 'object',
        properties: { include_usage: { type: 'boolean' } },
      },
    },
    required: ['model', 'messages'],
  },
  ChatCompletionResponse: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      object: { type: 'string' },
      model: {
        type: 'string',
        description:
          'Canonical model id actually used — Ark echoes the prefixed id back for aliases (e.g. dola-seed-2-1-turbo-260628).',
      },
      created: { type: 'integer', description: 'Unix seconds.' },
      service_tier: { type: 'string' },
      choices: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            index: { type: 'integer' },
            finish_reason: {
              type: 'string',
              description:
                "Why generation stopped — 'stop', 'length', 'tool_calls' or 'content_filter'.",
            },
            message: {
              type: 'object',
              properties: {
                role: { type: 'string' },
                content: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                reasoning_content: {
                  type: 'string',
                  description:
                    'Reasoning trace, delivered separately from answer text. Seed models reason by default.',
                },
                encrypted_content: {
                  type: 'string',
                  description:
                    'Opaque signature over the reasoning trace (thinking-summary models only); echo back on the next turn when present.',
                },
                tool_calls: {
                  type: 'array',
                  items: { $ref: '#/components/schemas/ChatToolCall' },
                },
              },
            },
          },
        },
      },
      usage: {
        type: 'object',
        properties: {
          prompt_tokens: { type: 'integer' },
          completion_tokens: { type: 'integer' },
          total_tokens: { type: 'integer' },
          prompt_tokens_details: {
            type: 'object',
            properties: { cached_tokens: { type: 'integer' } },
          },
          completion_tokens_details: {
            type: 'object',
            properties: { reasoning_tokens: { type: 'integer' } },
          },
        },
      },
    },
  },
}

// ---------------------------------------------------------------------------
// Image (/images/generations — Seedream)
// ---------------------------------------------------------------------------

const imageSchemas: Record<string, Schema> = {
  ImageGenerationRequest: {
    type: 'object',
    description:
      "Seedream image generation. Deviates from OpenAI's endpoint in three ways: there is no n parameter (group-image mode via sequential_image_generation instead), size accepts a shorthand token as well as WxH, and editing inputs ride in the top-level image field rather than a separate /images/edits endpoint.",
    properties: {
      model: {
        type: 'string',
        description:
          'Seedream model id (e.g. seedream-4-0-250828) or a preconfigured endpoint id.',
      },
      prompt: {
        type: 'string',
        description:
          'Instruction text (docs give the limit as 600 English words).',
      },
      image: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Input images for image-conditioned generation (editing, reference-guided generation, multi-reference composition). Each entry is a publicly reachable URL or a data:image/<format>;base64,<data> URI — <format> must be lowercase. Up to 14 references (10 on dola-seedream-5-0-pro-260628).',
      },
      size: {
        type: 'string',
        description:
          "Output size: a shorthand token ('1K', '2K', '4K') or explicit pixels ('2048x2048') — never a mix. Server default 2048x2048.",
      },
      response_format: {
        type: 'string',
        enum: ['url', 'b64_json'],
        description:
          "How generated images come back. 'url' links expire 24 hours after generation. Server default 'url'.",
      },
      output_format: {
        type: 'string',
        enum: ['png', 'jpeg'],
        description:
          "Generated file format. Seedream 5.0 family only; default 'jpeg'.",
      },
      watermark: {
        type: 'boolean',
        description:
          "Stamp an 'AI generated' watermark in the bottom-right corner. DEFAULTS TO TRUE — pass false to opt out.",
      },
      sequential_image_generation: {
        type: 'string',
        enum: ['auto', 'disabled'],
        description:
          "Group-image mode: 'auto' lets the model return a set of related images (bounded by sequential_image_generation_options.max_images — an upper bound, not a count); 'disabled' (server default) returns exactly one.",
      },
      sequential_image_generation_options: {
        type: 'object',
        properties: {
          max_images: {
            type: 'integer',
            minimum: 1,
            maximum: 15,
            description: 'Upper bound on images returned for this request.',
          },
        },
      },
      seed: {
        type: 'integer',
        description:
          'Randomness seed for reproducible generation. SDK-derived (byteplus-go-sdk-v2 GenerateImagesRequest.Seed; also in the Volcengine Python SDK) — not probe-verified.',
      },
      guidance_scale: {
        type: 'number',
        description:
          'How strictly the result follows the prompt; higher values adhere more closely at some cost to diversity. SDK-derived (byteplus-go-sdk-v2 GenerateImagesRequest.GuidanceScale) — not probe-verified.',
      },
      optimize_prompt: {
        type: 'boolean',
        description:
          'Toggle prompt rewriting. The finer-grained optimize_prompt_options selects the mode. SDK-derived (byteplus-go-sdk-v2) — not probe-verified.',
      },
      tools: {
        type: 'array',
        description:
          'Provider tools to run during generation; the only documented member is web search, and its usage comes back under usage.tool_usage.web_search. SDK-derived (byteplus-go-sdk-v2 ContentGenerationTool) — not probe-verified.',
        items: {
          type: 'object',
          properties: { type: { type: 'string' } },
          required: ['type'],
        },
      },
      optimize_prompt_options: {
        type: 'object',
        description: 'Prompt rewriting. Seedream 5.0-lite / 4.5 / 4.0 only.',
        properties: {
          mode: {
            type: 'string',
            enum: ['standard', 'fast'],
            description:
              "'standard' is higher quality but slower; 'fast' is unsupported on Seedream 5.0-lite and 4.5.",
          },
        },
        required: ['mode'],
      },
      stream: {
        type: 'boolean',
        description:
          'Server-sent-events mode, emitting each image as it finishes.',
      },
    },
    required: ['model', 'prompt'],
  },
  ImageErrorObject: {
    type: 'object',
    description:
      'Ark error object: dotted codes for transport failures (InvalidEndpointOrModel.NotFound), bare identifiers for content failures (OutputImageSensitiveContentDetected, QuotaExceeded).',
    properties: {
      code: { type: 'string' },
      message: { type: 'string' },
    },
  },
  ImageGenerationResponse: {
    type: 'object',
    properties: {
      model: { type: 'string' },
      created: { type: 'integer', description: 'Unix seconds.' },
      data: {
        type: 'array',
        items: {
          type: 'object',
          description:
            'A generated image, or (in group-image mode) a per-image failure. size is the actual pixel size produced and only returned by some models.',
          properties: {
            url: {
              type: 'string',
              description: 'Download URL; expires 24 hours after generation.',
            },
            b64_json: { type: 'string' },
            size: { type: 'string' },
            error: { $ref: '#/components/schemas/ImageErrorObject' },
          },
        },
      },
      usage: {
        type: 'object',
        description:
          'BytePlus bills images, not input tokens: total_tokens equals output_tokens, generated_images counts only successes.',
        properties: {
          generated_images: { type: 'integer' },
          output_tokens: { type: 'integer' },
          total_tokens: { type: 'integer' },
        },
      },
      error: { $ref: '#/components/schemas/ImageErrorObject' },
    },
  },
}

// ---------------------------------------------------------------------------
// Video (/contents/generations/tasks — Seedance async task API)
// ---------------------------------------------------------------------------

const videoSchemas: Record<string, Schema> = {
  VideoContentPart: {
    description:
      'One entry of the content array: prompt text plus image / video / audio inputs. The API sorts requests into task types from the roles present — i2v (first frame), flf2v (first + last frame) and r2v (reference media) — and the two families are mutually exclusive. On Seedance 2.0, reference_audio cannot be the only reference input.',
    oneOf: [
      {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['text'] },
          text: { type: 'string' },
        },
        required: ['type', 'text'],
      },
      {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['image_url'] },
          image_url: {
            type: 'object',
            properties: {
              url: {
                type: 'string',
                description:
                  'Public URL (fetched server-side) or data: URI carrying the bytes inline.',
              },
            },
            required: ['url'],
          },
          role: {
            type: 'string',
            enum: [
              'first_frame',
              'last_frame',
              'reference_image',
              'reference_video',
              'reference_audio',
            ],
            description:
              "Omitted for a bare first frame — the API defaults to 'first_frame'.",
          },
        },
        required: ['type', 'image_url'],
      },
      {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['video_url'] },
          video_url: {
            type: 'object',
            properties: { url: { type: 'string' } },
            required: ['url'],
          },
          role: {
            type: 'string',
            enum: [
              'first_frame',
              'last_frame',
              'reference_image',
              'reference_video',
              'reference_audio',
            ],
            description: "Reference-media mode requires 'reference_video'.",
          },
        },
        required: ['type', 'video_url'],
      },
      {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['audio_url'] },
          audio_url: {
            type: 'object',
            properties: { url: { type: 'string' } },
            required: ['url'],
          },
          role: {
            type: 'string',
            enum: [
              'first_frame',
              'last_frame',
              'reference_image',
              'reference_video',
              'reference_audio',
            ],
          },
        },
        required: ['type', 'audio_url'],
      },
    ],
  },
  VideoTaskCreateRequest: {
    type: 'object',
    description:
      'Open a Seedance video generation task. Only model and content are required; every other field is model-dependent and Ark rejects an inapplicable field outright rather than ignoring it, so send only what applies to the target model.',
    properties: {
      model: {
        type: 'string',
        description:
          'Seedance model id (e.g. seedance-1-5-pro-251215; the 2.0 family requires the dreamina- prefix) or a preconfigured endpoint id.',
      },
      content: {
        type: 'array',
        items: { $ref: '#/components/schemas/VideoContentPart' },
      },
      ratio: {
        type: 'string',
        description:
          "Output aspect ratio: 16:9, 9:16, 4:3, 3:4, 1:1, 21:9, or 'adaptive' (follows the input frame; image-to-video only).",
      },
      resolution: {
        type: 'string',
        description:
          'Resolution tier: 480p/720p on Seedance 2.5 and 2.0-fast/-mini, up to 1080p on the 1.x models and 4k on dreamina-seedance-2-0-260128. Matched case-insensitively by the API; there is no 2K tier on any model.',
      },
      duration: {
        type: 'integer',
        description:
          'Whole seconds of output (2-12s on 1.0, 4-12s on 1.5-pro, 4-15s on 2.0, 4-30s on 2.5). -1 lets the model choose (2.5 / 2.0 / 1.5-pro).',
      },
      frames: {
        type: 'integer',
        description:
          'Frame count, an alternative to duration that allows fractional seconds.',
      },
      seed: {
        type: 'integer',
        description:
          'Randomness seed; integers in [-1, 2^32-1], where -1 means unseeded.',
      },
      camera_fixed: {
        type: 'boolean',
        description:
          "Appends a 'fix the camera' instruction to the prompt. Default false.",
      },
      watermark: {
        type: 'boolean',
        description: 'Burn a watermark into the output. Default false.',
      },
      generate_audio: {
        type: 'boolean',
        description: 'Generate a synchronized audio track. Default false.',
      },
      service_tier: {
        type: 'string',
        enum: ['default', 'flex'],
        description:
          "'default' (online) or 'flex' (offline batch, half price). Note flex tasks are missing from the default task listing unless filter.service_tier=flex is passed.",
      },
      return_last_frame: {
        type: 'boolean',
        description: 'Also return the final frame as a PNG. Default false.',
      },
      draft: {
        type: 'boolean',
        description: 'Cheap low-fidelity preview render. Default false.',
      },
      priority: {
        type: 'integer',
        minimum: 0,
        maximum: 9,
        description: 'Queue priority.',
      },
      output_format: {
        type: 'string',
        description: 'Container of the generated video, e.g. mp4 or mov.',
      },
      execution_expires_after: {
        type: 'integer',
        description:
          "Seconds from created_at after which the task is marked 'expired'.",
      },
      callback_url: {
        type: 'string',
        description:
          'URL that receives a POST with the task payload on each status change.',
      },
      safety_identifier: {
        type: 'string',
        maxLength: 64,
        description: 'Opaque per-end-user identifier for abuse attribution.',
      },
    },
    required: ['model', 'content'],
  },
  VideoTaskCreateResponse: {
    type: 'object',
    description:
      'Task acknowledgment (live-verified: the body is just the task id, e.g. cgt-batch-20260731174311-zmz5s — the -batch infix appears on flex-tier routing). Poll GET /contents/generations/tasks/{id} until status is terminal; the video URL arrives with the succeeded status and expires 24 hours later (the task record itself is kept for 7 days).',
    properties: {
      id: { type: 'string' },
    },
  },
}

/** Ark data-plane document: chat, Seedream image, Seedance video. */
export function bytePlusArkSpec(): OpenApiDocument {
  return {
    openapi: '3.1.0',
    info: {
      title: 'BytePlus ModelArk API',
      version: 'v3',
      description:
        'Synthesized from @tanstack/ai-byteplus wire types (harvested Ark OpenAPI documents + live probes, 2026-07-31). Auth: Authorization: Bearer $ARK_API_KEY; keys are region-isolated.',
    },
    servers: [{ url: BYTEPLUS_ARK_BASE_URL }],
    paths: {
      '/chat/completions': {
        post: {
          operationId: 'createChatCompletion',
          summary:
            'Chat completion (Seed / GLM / DeepSeek / gpt-oss) — OpenAI-compatible plus thinking, reasoning_effort, repetition_penalty and service_tier',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ChatCompletionRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Completion',
              content: {
                'application/json': {
                  schema: {
                    $ref: '#/components/schemas/ChatCompletionResponse',
                  },
                },
              },
            },
          },
        },
      },
      '/images/generations': {
        post: {
          operationId: 'createImageGeneration',
          summary: 'Generate or edit images with Seedream',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ImageGenerationRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Generated images',
              content: {
                'application/json': {
                  schema: {
                    $ref: '#/components/schemas/ImageGenerationResponse',
                  },
                },
              },
            },
          },
        },
      },
      '/contents/generations/tasks': {
        post: {
          operationId: 'createContentsGenerationsTask',
          summary:
            'Open a Seedance video generation task (async — poll GET /contents/generations/tasks/{id} for the result)',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/VideoTaskCreateRequest',
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Task acknowledgment',
              content: {
                'application/json': {
                  schema: {
                    $ref: '#/components/schemas/VideoTaskCreateResponse',
                  },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: { ...chatSchemas, ...imageSchemas, ...videoSchemas },
    },
  }
}

// ---------------------------------------------------------------------------
// Seed Speech (voice host — separate product and API key)
// ---------------------------------------------------------------------------

const voiceSchemas: Record<string, Schema> = {
  TTSReference: {
    type: 'object',
    description:
      'Voice selection / cloning reference. Exactly one of speaker, audio_url or audio_data per entry; at most 3 audio references (30s / 10MB each) and 1 image reference (10MB), and image references are mutually exclusive with audio ones. The @Audio1..@Audio3 markers in text_prompt address audio references positionally.',
    properties: {
      speaker: {
        type: 'string',
        description: 'Stock voice id, e.g. en_female_stokie_uranus_bigtts.',
      },
      audio_url: {
        type: 'string',
        description: 'URL of a reference clip to clone (≤30s, ≤10MB).',
      },
      audio_data: {
        type: 'string',
        description: 'Base64 reference clip to clone (≤30s, ≤10MB).',
      },
      image_url: {
        type: 'string',
        description: 'URL of a reference image (≤10MB).',
      },
      image_data: {
        type: 'string',
        description: 'Base64 reference image (≤10MB).',
      },
    },
  },
  TTSAudioConfig: {
    type: 'object',
    description:
      "Audio output configuration. The *_rate fields are integer percentages relative to the voice's neutral delivery, not multipliers.",
    properties: {
      format: {
        type: 'string',
        enum: ['wav', 'mp3', 'pcm', 'ogg_opus'],
        description: "Output container/codec. Server default 'wav'.",
      },
      sample_rate: {
        type: 'integer',
        enum: [8000, 16000, 24000, 32000, 44100, 48000],
        description:
          'Output sample rate in Hz. (The documented default of 40000 is not a valid value — send an explicit rate.)',
      },
      speech_rate: {
        type: 'integer',
        minimum: -50,
        maximum: 100,
        description: 'Speaking rate: -50 = 0.5x, 0 = 1x, 100 = 2x.',
      },
      loudness_rate: {
        type: 'integer',
        minimum: -50,
        maximum: 100,
        description: "Loudness adjustment; 0 is the voice's natural level.",
      },
      pitch_rate: {
        type: 'integer',
        minimum: -12,
        maximum: 12,
        description: "Pitch adjustment; 0 is the voice's natural pitch.",
      },
      enable_subtitle: {
        type: 'boolean',
        description:
          'Emit sentence and word timings in the response. Default false.',
      },
    },
  },
  TTSCreateRequest: {
    type: 'object',
    description:
      'Seed Speech synthesis. Output audio is capped at 120 seconds (before rate adjustment).',
    properties: {
      model: {
        type: 'string',
        description: 'Seed Speech synthesis model, e.g. seed-audio-1.0.',
      },
      text_prompt: {
        type: 'string',
        maxLength: 3000,
        description:
          "The text to speak. Dual-purpose: literal text or a natural-language description of the delivery, and where the @Audio1..@Audio3 reference markers go. (The field is text_prompt, not text — the 'text' spelling belongs to the separate /tts/unidirectional endpoint.)",
      },
      references: {
        type: 'array',
        items: { $ref: '#/components/schemas/TTSReference' },
      },
      audio_config: { $ref: '#/components/schemas/TTSAudioConfig' },
      watermark: {
        type: 'boolean',
        description: 'Watermark the generated audio.',
      },
    },
    required: ['model', 'text_prompt'],
  },
  TTSSubtitleEntry: {
    type: 'object',
    description:
      "One timed entry. Times are MILLISECONDS — unlike the response's duration fields, which are seconds.",
    properties: {
      text: { type: 'string' },
      start_time: { type: 'number' },
      end_time: { type: 'number' },
    },
  },
  TTSCreateResponse: {
    type: 'object',
    description:
      'Success envelope (docs-derived). Errors come back as a flat numeric code, e.g. {"code": 45000010, "message": "Invalid X-Api-Key"}.',
    properties: {
      code: {
        description: '0 on success, a flat error code otherwise.',
        oneOf: [{ type: 'integer' }, { type: 'string' }],
      },
      message: { type: 'string' },
      audio: {
        type: 'string',
        description: 'Base64-encoded audio in the requested format.',
      },
      duration: {
        description:
          'Length of the delivered audio in SECONDS (float), after speech_rate is applied.',
        oneOf: [{ type: 'number' }, { type: 'string' }],
      },
      original_duration: {
        description:
          'Length in SECONDS before rate adjustment — the billing basis, capped at 120.',
        oneOf: [{ type: 'number' }, { type: 'string' }],
      },
      url: {
        type: 'string',
        description:
          'Temporary download URL for the same audio. Expires after ~2 hours.',
      },
      subtitle: {
        type: 'object',
        properties: {
          sentences: {
            type: 'array',
            items: { $ref: '#/components/schemas/TTSSubtitleEntry' },
          },
          words: {
            type: 'array',
            items: { $ref: '#/components/schemas/TTSSubtitleEntry' },
          },
        },
      },
    },
  },
  ASRUtterance: {
    type: 'object',
    description:
      'One recognised utterance; start_time/end_time are milliseconds.',
    properties: {
      text: { type: 'string' },
      start_time: { type: 'number' },
      end_time: { type: 'number' },
      words: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            start_time: { type: 'number' },
            end_time: { type: 'number' },
            confidence: { type: 'number' },
          },
        },
      },
      additions: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description:
          'Extra per-utterance annotations; speaker labels arrive here when enable_speaker_info is set.',
      },
    },
  },
  ASRRecognizeRequest: {
    type: 'object',
    description:
      "Flash (synchronous) recognition. The model is selected entirely by the X-Api-Resource-Id header ('volc.seedasr.auc_turbo') — there is no model field in the body. Files up to 2 hours / 100MB.",
    properties: {
      user: {
        type: 'object',
        properties: { uid: { type: 'string' } },
      },
      audio: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'Publicly reachable URL of the audio file.',
          },
          data: {
            type: 'string',
            description: 'Base64-encoded audio bytes.',
          },
          format: {
            type: 'string',
            description: 'Container hint, e.g. mp3, wav, ogg.',
          },
        },
      },
      request: {
        type: 'object',
        properties: {
          model_name: {
            type: 'string',
            description: "Recognition model family. Defaults to 'bigmodel'.",
          },
          enable_itn: {
            type: 'boolean',
            description:
              'Inverse text normalisation (spoken numbers → digits).',
          },
          enable_punc: { type: 'boolean', description: 'Insert punctuation.' },
          enable_ddc: {
            type: 'boolean',
            description: "Disfluency removal ('um', repeated words).",
          },
          enable_speaker_info: {
            type: 'boolean',
            description: 'Attach per-utterance speaker labels.',
          },
          show_utterances: {
            type: 'boolean',
            description:
              'Return the utterances breakdown as well as the flat transcript.',
          },
          language: {
            type: 'string',
            description: 'Spoken language hint, e.g. en-US.',
          },
        },
      },
    },
    required: ['audio'],
  },
  ASRRecognizeResponse: {
    type: 'object',
    description:
      'The Volcengine-lineage wire shape nests everything under result; the flat transcript/utterances spellings are tolerated aliases.',
    properties: {
      audio_info: {
        type: 'object',
        properties: {
          duration: {
            type: 'number',
            description: 'Audio length in MILLISECONDS.',
          },
        },
      },
      result: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          utterances: {
            type: 'array',
            items: { $ref: '#/components/schemas/ASRUtterance' },
          },
        },
      },
      transcript: {
        type: 'string',
        description: 'Flat alias for result.text.',
      },
      utterances: {
        type: 'array',
        items: { $ref: '#/components/schemas/ASRUtterance' },
      },
    },
  },
}

/** Seed Speech document: TTS + flash ASR on the voice host. */
export function bytePlusVoiceSpec(): OpenApiDocument {
  return {
    openapi: '3.1.0',
    info: {
      title: 'BytePlus Seed Speech API',
      version: 'v3',
      description:
        'Synthesized from @tanstack/ai-byteplus wire types (BytePlus Seed Speech docs + Volcengine flash-recognition reference). Auth: X-Api-Key: $BYTEPLUS_VOICE_API_KEY — a separate product key from Ark; an Ark key fails with 45000010 Invalid X-Api-Key.',
    },
    servers: [{ url: BYTEPLUS_VOICE_BASE_URL }],
    paths: {
      '/tts/create': {
        post: {
          operationId: 'createSpeech',
          summary:
            'Synthesize speech with Seed Audio (stock voices or reference-clip cloning)',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/TTSCreateRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Synthesized audio',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/TTSCreateResponse' },
                },
              },
            },
          },
        },
      },
      '/auc/bigmodel/recognize/flash': {
        post: {
          operationId: 'recognizeFlash',
          summary:
            'Transcribe audio with Seed ASR (model selected via the X-Api-Resource-Id header)',
          parameters: [
            {
              name: 'X-Api-Resource-Id',
              in: 'header',
              required: true,
              schema: { type: 'string', enum: ['volc.seedasr.auc_turbo'] },
              description:
                'Selects the Seed ASR turbo model; the body takes no model field.',
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ASRRecognizeRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Transcription',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ASRRecognizeResponse' },
                },
              },
            },
          },
        },
      },
    },
    components: { schemas: voiceSchemas },
  }
}
