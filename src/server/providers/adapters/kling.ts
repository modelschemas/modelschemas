/**
 * Kling AI — no public OpenAPI (the hinted docs URL is HTML; /openapi.json
 * 404s on api.klingai.com and api-singapore.klingai.com). Spec is hand-written
 * from official docs for the three generation POSTs.
 *
 * Auth: a modern console key is `Authorization: Bearer $KLING_API_KEY`.
 * Legacy access-key + secret JWTs are not minted here. Kling publishes no
 * /models list — listModels skips without the key and otherwise returns a
 * small docs-derived catalog (calling the create URL would enqueue a job).
 */
import type { Activity } from '#/db/schema.ts'
import { contentHash } from '#/server/kv.ts'
import { skippedResult } from '../types.ts'
import type {
  ListModelsResult,
  ModelInfo,
  OpenApiDocument,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

export const KLING_DOCS_URL = 'https://app.klingai.com/global/dev/document-api'
export const KLING_API_BASE = 'https://api.klingai.com'
export const KLING_SINGAPORE_API_BASE = 'https://api-singapore.klingai.com'
export const KLING_MODELS_ENDPOINT = `${KLING_API_BASE}/v1/videos/text2video`

const GENERATION_PATHS: Record<string, Activity> = {
  '/v1/videos/text2video': 'video',
  '/v1/videos/image2video': 'video',
  '/v1/images/generations': 'image',
}

type Schema = Record<string, unknown>

const cameraConfigSchema: Schema = {
  type: 'object',
  description:
    'Fine-grained camera motion when camera_control.type is `simple`. Official docs allow only one non-zero axis per request. Each axis is in [-10, 10].',
  properties: {
    horizontal: { type: 'number', minimum: -10, maximum: 10 },
    vertical: { type: 'number', minimum: -10, maximum: 10 },
    pan: { type: 'number', minimum: -10, maximum: 10 },
    tilt: { type: 'number', minimum: -10, maximum: 10 },
    roll: { type: 'number', minimum: -10, maximum: 10 },
    zoom: { type: 'number', minimum: -10, maximum: 10 },
  },
}

const cameraControlSchema: Schema = {
  type: 'object',
  description:
    'Camera movement. Presets: simple, down_back, forward_up, right_turn_forward, left_turn_forward. Supported on older models (kling-v1 / v1.5 / v1.6), not v2.x.',
  properties: {
    type: {
      type: 'string',
      enum: [
        'simple',
        'down_back',
        'forward_up',
        'right_turn_forward',
        'left_turn_forward',
      ],
    },
    config: { $ref: '#/components/schemas/CameraConfig' },
  },
}

const voiceRefSchema: Schema = {
  type: 'object',
  required: ['voice_id'],
  properties: {
    voice_id: {
      type: 'string',
      description: 'Voice id referenced from the prompt as <<<voice_1>>> …',
    },
  },
}

const dynamicMaskSchema: Schema = {
  type: 'object',
  required: ['mask', 'trajectories'],
  properties: {
    mask: {
      type: 'string',
      description: 'Brush mask as a raw base64 image or https URL.',
    },
    trajectories: {
      type: 'array',
      description: 'Motion path; 2–77 {x,y} points for a 5s clip.',
      minItems: 2,
      items: {
        type: 'object',
        required: ['x', 'y'],
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
        },
      },
    },
  },
}

const text2VideoRequest: Schema = {
  type: 'object',
  required: ['prompt'],
  properties: {
    model_name: {
      type: 'string',
      description:
        'Video model id. Documented values include kling-v1, kling-v1-6, kling-v2-master, kling-v2-1-master, kling-v2-5-turbo, kling-v2-6, kling-v3. Default kling-v1.',
    },
    prompt: {
      type: 'string',
      maxLength: 2500,
      description: 'Positive scene prompt.',
    },
    negative_prompt: { type: 'string', maxLength: 2500 },
    sound: {
      type: 'string',
      enum: ['on', 'off'],
      description:
        'Native audio. v2.6+ (typically requires mode=pro). Default off.',
    },
    cfg_scale: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description: 'Prompt adherence. Default 0.5. Not supported on v2.x.',
    },
    mode: {
      type: 'string',
      enum: ['std', 'pro'],
      description: 'Quality tier. Default std.',
    },
    aspect_ratio: {
      type: 'string',
      enum: ['16:9', '9:16', '1:1'],
      description: 'Default 16:9.',
    },
    duration: {
      type: 'string',
      description:
        'Clip length in seconds, sent as a string. Classic models: 5 or 10. Newer 3.0 models accept 3–15.',
    },
    camera_control: { $ref: '#/components/schemas/CameraControl' },
    multi_shot: {
      type: 'boolean',
      description: 'Split the clip into storyboard shots (v3.0+).',
    },
    shot_type: {
      type: 'string',
      enum: ['customize', 'intelligence'],
      description: 'Required when multi_shot is true.',
    },
    multi_prompt: {
      type: 'array',
      description:
        'Per-shot prompts when shot_type=customize. Durations must sum to duration.',
      items: { $ref: '#/components/schemas/MultiPromptShot' },
    },
    callback_url: {
      type: 'string',
      format: 'uri',
      description: 'Webhook for task status changes.',
    },
    external_task_id: {
      type: 'string',
      description: 'Caller-chosen id; must be unique per account.',
    },
  },
}

const multiPromptShot: Schema = {
  type: 'object',
  required: ['index', 'prompt', 'duration'],
  properties: {
    index: { type: 'integer', minimum: 1 },
    prompt: { type: 'string', maxLength: 512 },
    duration: { type: 'string', description: 'Shot length in seconds.' },
  },
}

const image2VideoRequest: Schema = {
  type: 'object',
  description:
    'At least one of `image` or `image_tail` is required. image + image_tail, motion brushes, and camera_control are mutually exclusive families.',
  properties: {
    model_name: {
      type: 'string',
      description:
        'Video model id. Documented values include kling-v1, kling-v1-5, kling-v1-6, kling-v2-master, kling-v2-1, kling-v2-1-master, kling-v2-5-turbo, kling-v2-6, kling-v3.',
    },
    image: {
      type: 'string',
      description:
        'Start frame: https URL or raw base64 (no data: URI prefix). jpg/png, ≤10MB, ≥300px, aspect 1:2.5–2.5:1.',
    },
    image_tail: {
      type: 'string',
      description: 'End frame (same encoding). Usually requires mode=pro.',
    },
    prompt: { type: 'string', maxLength: 2500 },
    negative_prompt: { type: 'string', maxLength: 2500 },
    voice_list: {
      type: 'array',
      maxItems: 2,
      description:
        'Voice references (v2.6+). Reference via <<<voice_1>>> in prompt.',
      items: { $ref: '#/components/schemas/VoiceRef' },
    },
    sound: { type: 'string', enum: ['on', 'off'] },
    cfg_scale: { type: 'number', minimum: 0, maximum: 1 },
    mode: { type: 'string', enum: ['std', 'pro'] },
    static_mask: {
      type: 'string',
      description: 'Static brush mask (base64 or URL).',
    },
    dynamic_masks: {
      type: 'array',
      maxItems: 6,
      items: { $ref: '#/components/schemas/DynamicMask' },
    },
    camera_control: { $ref: '#/components/schemas/CameraControl' },
    aspect_ratio: { type: 'string', enum: ['16:9', '9:16', '1:1'] },
    duration: {
      type: 'string',
      description: 'Clip length in seconds as a string (5 or 10; 3–15 on 3.0).',
    },
    callback_url: { type: 'string', format: 'uri' },
    external_task_id: { type: 'string' },
  },
}

const imageGenerationsRequest: Schema = {
  type: 'object',
  required: ['prompt'],
  properties: {
    model_name: {
      type: 'string',
      description:
        'Image model id. Documented values include kling-v1, kling-v1-5, kling-v2, kling-v2-new, kling-v2-1, kling-image-o1. Default kling-v1.',
    },
    prompt: { type: 'string', maxLength: 2500 },
    negative_prompt: {
      type: 'string',
      maxLength: 2500,
      description: 'Not supported in image-to-image mode.',
    },
    image: {
      type: 'string',
      description: 'Reference image (raw base64 or https URL).',
    },
    image_reference: {
      type: 'string',
      enum: ['subject', 'face'],
      description: 'Required on kling-v1-5 when `image` is set.',
    },
    image_fidelity: { type: 'number', minimum: 0, maximum: 1 },
    human_fidelity: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description:
        'Face similarity when image_reference=subject. Default 0.45.',
    },
    resolution: { type: 'string', enum: ['1k', '2k'] },
    n: {
      type: 'integer',
      minimum: 1,
      maximum: 9,
      description: 'Number of images. Each occupies one concurrency slot.',
    },
    aspect_ratio: {
      type: 'string',
      enum: ['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3', '21:9'],
    },
    callback_url: { type: 'string', format: 'uri' },
    external_task_id: { type: 'string' },
  },
}

const createTaskResponse: Schema = {
  type: 'object',
  description:
    'Create-task ack. Poll GET {path}/{task_id} until task_status is succeed or failed; results live under data.task_result.',
  properties: {
    code: {
      type: 'integer',
      description: '0 on success. Non-zero is an API error even on HTTP 200.',
    },
    message: { type: 'string' },
    request_id: { type: 'string' },
    data: { $ref: '#/components/schemas/CreateTaskData' },
  },
}

const createTaskData: Schema = {
  type: 'object',
  properties: {
    task_id: { type: 'string' },
    task_status: {
      type: 'string',
      enum: ['submitted', 'processing', 'succeed', 'failed'],
    },
    task_info: {
      type: 'object',
      properties: { external_task_id: { type: 'string' } },
    },
    created_at: { type: 'integer', description: 'Unix timestamp in ms.' },
    updated_at: { type: 'integer', description: 'Unix timestamp in ms.' },
  },
}

const queryTaskResponse: Schema = {
  type: 'object',
  properties: {
    code: { type: 'integer' },
    message: { type: 'string' },
    request_id: { type: 'string' },
    data: { $ref: '#/components/schemas/QueryTaskData' },
  },
}

const queryTaskData: Schema = {
  type: 'object',
  properties: {
    task_id: { type: 'string' },
    task_status: {
      type: 'string',
      enum: ['submitted', 'processing', 'succeed', 'failed'],
    },
    task_status_msg: { type: 'string' },
    task_info: {
      type: 'object',
      properties: { external_task_id: { type: 'string' } },
    },
    created_at: { type: 'integer' },
    updated_at: { type: 'integer' },
    task_result: { $ref: '#/components/schemas/TaskResult' },
  },
}

const taskResult: Schema = {
  type: 'object',
  properties: {
    videos: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          url: { type: 'string', format: 'uri' },
          duration: { type: 'string' },
        },
      },
    },
    images: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          url: { type: 'string', format: 'uri' },
        },
      },
    },
  },
}

function jsonBody(schemaRef: string) {
  return {
    required: true,
    content: {
      'application/json': {
        schema: { $ref: `#/components/schemas/${schemaRef}` },
      },
    },
  }
}

function jsonResponse(description: string, schemaRef: string) {
  return {
    description,
    content: {
      'application/json': {
        schema: { $ref: `#/components/schemas/${schemaRef}` },
      },
    },
  }
}

function klingSpec(): OpenApiDocument {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Kling AI API',
      version: 'docs-derived',
      description:
        'Hand-written from official Kling docs (https://app.klingai.com/global/dev/document-api). No published OpenAPI. Current host is api-singapore.klingai.com; api.klingai.com still appears in older docs. Auth is Bearer — a console API key, or a 30-minute HS256 JWT (iss=access key) for the legacy key pair. Create POSTs return a task ack; poll the sibling GET until succeed/failed.',
    },
    servers: [
      { url: KLING_SINGAPORE_API_BASE, description: 'Current official host' },
      { url: KLING_API_BASE, description: 'Legacy host from older docs' },
    ],
    security: [{ bearerAuth: [] }],
    paths: {
      '/v1/videos/text2video': {
        post: {
          operationId: 'createText2Video',
          summary: 'Create a text-to-video task',
          tags: ['video'],
          requestBody: jsonBody('Text2VideoRequest'),
          responses: {
            '200': jsonResponse('Task accepted', 'CreateTaskResponse'),
          },
        },
        get: {
          operationId: 'listText2VideoTasks',
          summary: 'List text-to-video tasks',
          tags: ['platform'],
          responses: {
            '200': jsonResponse('Task page', 'QueryTaskResponse'),
          },
        },
      },
      '/v1/videos/text2video/{task_id}': {
        get: {
          operationId: 'getText2VideoTask',
          summary: 'Query a text-to-video task',
          tags: ['platform'],
          parameters: [
            {
              name: 'task_id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
          responses: {
            '200': jsonResponse('Task status', 'QueryTaskResponse'),
          },
        },
      },
      '/v1/videos/image2video': {
        post: {
          operationId: 'createImage2Video',
          summary: 'Create an image-to-video task',
          tags: ['video'],
          requestBody: jsonBody('Image2VideoRequest'),
          responses: {
            '200': jsonResponse('Task accepted', 'CreateTaskResponse'),
          },
        },
      },
      '/v1/videos/image2video/{task_id}': {
        get: {
          operationId: 'getImage2VideoTask',
          summary: 'Query an image-to-video task',
          tags: ['platform'],
          parameters: [
            {
              name: 'task_id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
          responses: {
            '200': jsonResponse('Task status', 'QueryTaskResponse'),
          },
        },
      },
      '/v1/images/generations': {
        post: {
          operationId: 'createImageGeneration',
          summary: 'Create an image generation task',
          tags: ['image'],
          requestBody: jsonBody('ImageGenerationsRequest'),
          responses: {
            '200': jsonResponse('Task accepted', 'CreateTaskResponse'),
          },
        },
      },
      '/v1/images/generations/{task_id}': {
        get: {
          operationId: 'getImageGenerationTask',
          summary: 'Query an image generation task',
          tags: ['platform'],
          parameters: [
            {
              name: 'task_id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
          responses: {
            '200': jsonResponse('Task status', 'QueryTaskResponse'),
          },
        },
      },
      '/account/costs': {
        get: {
          operationId: 'getAccountCosts',
          summary: 'Query resource-pack usage',
          tags: ['platform'],
          responses: {
            '200': { description: 'Account resource packs' },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description:
            'Modern console API key, or a short-lived HS256 JWT minted from the legacy access-key + secret pair (iss=access key, exp ≈ now+1800, nbf ≈ now-5).',
        },
      },
      schemas: {
        CameraConfig: cameraConfigSchema,
        CameraControl: cameraControlSchema,
        VoiceRef: voiceRefSchema,
        DynamicMask: dynamicMaskSchema,
        MultiPromptShot: multiPromptShot,
        Text2VideoRequest: text2VideoRequest,
        Image2VideoRequest: image2VideoRequest,
        ImageGenerationsRequest: imageGenerationsRequest,
        CreateTaskResponse: createTaskResponse,
        CreateTaskData: createTaskData,
        QueryTaskResponse: queryTaskResponse,
        QueryTaskData: queryTaskData,
        TaskResult: taskResult,
      },
    },
  }
}

function classify(path: string): Activity | null {
  const bare = path.split('?')[0] ?? path
  return GENERATION_PATHS[bare] ?? null
}

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const spec = klingSpec()
  return {
    specs: [spec],
    sources: [{ url: KLING_DOCS_URL, hash: await contentHash(spec) }],
    outputStrategy: 'post-200',
  }
}

/** Docs-derived catalog — Kling has no GET /models. */
const CURATED_MODELS: Array<ModelInfo> = [
  { rawId: 'kling-v1', displayName: 'Kling V1', activity: 'video' },
  { rawId: 'kling-v1-5', displayName: 'Kling V1.5', activity: 'image' },
  { rawId: 'kling-v1-6', displayName: 'Kling V1.6', activity: 'video' },
  {
    rawId: 'kling-v2-master',
    displayName: 'Kling V2 Master',
    activity: 'video',
  },
  {
    rawId: 'kling-v2-1',
    displayName: 'Kling V2.1',
    activity: 'image',
  },
  {
    rawId: 'kling-v2-1-master',
    displayName: 'Kling V2.1 Master',
    activity: 'video',
  },
  {
    rawId: 'kling-v2-5-turbo',
    displayName: 'Kling V2.5 Turbo',
    activity: 'video',
  },
  { rawId: 'kling-v2-6', displayName: 'Kling V2.6', activity: 'video' },
  { rawId: 'kling-v2', displayName: 'Kling V2 Image', activity: 'image' },
  { rawId: 'kling-v2-new', displayName: 'Kling V2 New', activity: 'image' },
  { rawId: 'kling-v3', displayName: 'Kling V3', activity: 'video' },
  { rawId: 'kling-image-o1', displayName: 'Kling Image O1', activity: 'image' },
  { rawId: 'kling-video-o1', displayName: 'Kling Video O1', activity: 'video' },
]

async function listModels(env: ProviderSecrets): Promise<ListModelsResult> {
  if (!env.KLING_API_KEY) {
    return { models: [], ...skippedResult('kling', 'KLING_API_KEY') }
  }
  // Presence of the key enables the catalog. There is no models endpoint to
  // call — POST /v1/videos/text2video creates a generation task.
  return { models: CURATED_MODELS }
}

export const provider: ProviderConfig = {
  id: 'kling',
  displayName: 'Kling AI',
  authEnvVar: 'KLING_API_KEY',
  specSourceUrl: KLING_DOCS_URL,
  modelsEndpoint: KLING_MODELS_ENDPOINT,
  defaultDerivation: 'docs-derived',
  fetchSpec,
  listModels,
  classify,
}
