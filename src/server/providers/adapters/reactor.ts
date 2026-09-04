/**
 * Reactor (reactor.inc) — real-time world/video models. No public OpenAPI
 * (`/openapi.json` 404s). The runtime compiles a per-model OpenAPI document
 * (`POST /events/<command>`) after session connect; we cannot fetch that
 * without opening a GPU session. Spec is hand-written from
 * https://docs.reactor.inc.
 *
 * HTTP control plane: POST /tokens (auth — classified null) and POST
 * /sessions (video). Each hosted model also gets a synthetic POST
 * /models/{connectSlug} whose body is the WebRTC `sendCommand` envelope.
 *
 * Model catalog is public GET /pricing (keyless). GET /models needs a
 * bearer and is not polled. Auth for the live data plane is the
 * `Reactor-API-Key` header (`rk_...`); browser clients exchange it for a
 * session-scoped JWT via POST /tokens.
 */
import type { Activity } from '#/db/schema.ts'
import { contentHash } from '#/server/kv.ts'
import { fetchJson } from '../types.ts'
import type {
  ListModelsResult,
  ModelInfo,
  OpenApiDocument,
  OpenApiOperation,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

export const REACTOR_DOCS_URL = 'https://docs.reactor.inc'
export const REACTOR_API_BASE = 'https://api.reactor.inc'
export const REACTOR_PRICING_URL = `${REACTOR_API_BASE}/pricing`
export const REACTOR_MODELS_URL = `${REACTOR_API_BASE}/models`

type Schema = Record<string, unknown>

interface CommandDef {
  name: string
  description: string
  required?: Array<string>
  properties?: Record<string, Schema>
}

interface ReactorModel {
  /** Pricing catalog `name` (and create-reactor-app template slug). */
  pricingName: string
  /** Connect slug passed as `modelName` / `model_name`. */
  rawId: string
  displayName: string
  commands: Array<CommandDef>
}

const fileRef: Schema = {
  $ref: '#/components/schemas/FileRef',
}

function promptCommand(description: string): CommandDef {
  return {
    name: 'set_prompt',
    description,
    required: ['prompt'],
    properties: { prompt: { type: 'string', description } },
  }
}

function seedCommand(): CommandDef {
  return {
    name: 'set_seed',
    description:
      'Set the RNG seed. Read once at start; pass -1 for a fresh random seed.',
    required: ['seed'],
    properties: {
      seed: {
        type: 'integer',
        description: 'Seed value. -1 draws a random seed per run.',
      },
    },
  }
}

function playbackCommands(extras: Array<CommandDef> = []): Array<CommandDef> {
  return [
    { name: 'start', description: 'Begin generation on the output tracks.' },
    { name: 'pause', description: 'Pause after the current chunk finishes.' },
    { name: 'resume', description: 'Resume generation from a pause.' },
    ...extras,
    {
      name: 'reset',
      description: 'Clear session state and return the model to idle.',
    },
  ]
}

function imageCommand(
  name: string,
  field: string,
  description: string,
): CommandDef {
  return {
    name,
    description,
    required: [field],
    properties: { [field]: { ...fileRef, description } },
  }
}

const HELIOS_COMMANDS: Array<CommandDef> = [
  promptCommand(
    'Set the prompt at chunk 0, the current chunk if paused, or the next chunk if running.',
  ),
  {
    name: 'schedule_prompt',
    description: 'Schedule a prompt at a specific chunk index.',
    required: ['prompt', 'chunk'],
    properties: {
      prompt: { type: 'string' },
      chunk: { type: 'integer', minimum: 0 },
    },
  },
  imageCommand(
    'set_image',
    'image',
    'Reference image (FileRef from uploadFile). Center-cropped to 5:3, then 640×384.',
  ),
  {
    name: 'set_conditioning',
    description:
      'Set prompt and reference image atomically so the first chunk is conditioned on both.',
    required: ['prompt', 'image'],
    properties: {
      prompt: { type: 'string' },
      image: fileRef,
    },
  },
  {
    name: 'set_image_strength',
    description:
      'How strongly the reference image anchors output. Ignored when no image is set.',
    required: ['image_strength'],
    properties: {
      image_strength: { type: 'number', minimum: 0, maximum: 1, default: 1 },
    },
  },
  {
    name: 'set_sr_scale',
    description:
      'Super-resolution applied to emitted frames. Native generation is 640×384.',
    required: ['sr_scale'],
    properties: {
      sr_scale: { type: 'string', enum: ['off', '2x', '4x'], default: '2x' },
    },
  },
  seedCommand(),
  ...playbackCommands(),
  {
    name: 'save_snapshot',
    description:
      'Capture the current world state into the rewind buffer (max 50).',
    properties: {
      label: {
        type: 'string',
        description: 'Display-only name for the snapshot.',
      },
    },
  },
  {
    name: 'rewind',
    description:
      'Restore a saved snapshot. Does not restore the prompt — re-send it after rewind.',
    properties: {
      snapshot_index: {
        type: 'integer',
        description:
          'Positive index from list_snapshots, or negative from the newest (-1 default).',
        default: -1,
      },
    },
  },
  {
    name: 'list_snapshots',
    description: 'Read the rewind buffer. Reply is a snapshot_list message.',
  },
]

const LINGBOT_COMMANDS: Array<CommandDef> = [
  promptCommand(
    'Text prompt that steers atmosphere and content (required before start).',
  ),
  imageCommand(
    'set_image',
    'image',
    'Seed image that anchors the world (required before start).',
  ),
  {
    name: 'set_movement',
    description: 'WASD movement direction. Persistent until the next value.',
    required: ['movement'],
    properties: {
      movement: {
        type: 'string',
        enum: ['idle', 'forward', 'backward', 'left', 'right'],
      },
    },
  },
  {
    name: 'set_look_horizontal',
    description: 'Yaw (look left/right). Persistent until the next value.',
    required: ['look_horizontal'],
    properties: {
      look_horizontal: { type: 'string', enum: ['idle', 'left', 'right'] },
    },
  },
  {
    name: 'set_look_vertical',
    description: 'Pitch (look up/down). Persistent until the next value.',
    required: ['look_vertical'],
    properties: {
      look_vertical: { type: 'string', enum: ['idle', 'up', 'down'] },
    },
  },
  {
    name: 'set_rotation_speed_deg',
    description: 'How fast the camera rotates when a look axis is active.',
    required: ['rotation_speed_deg'],
    properties: {
      rotation_speed_deg: { type: 'number', minimum: 0, maximum: 30 },
    },
  },
  seedCommand(),
  ...playbackCommands(),
]

const LINGBOT_WORLD_2_COMMANDS: Array<CommandDef> = [
  promptCommand(
    'Text prompt that steers atmosphere and content (required before start).',
  ),
  imageCommand(
    'set_image',
    'image',
    'Reference image that anchors the world (required before start).',
  ),
  seedCommand(),
  {
    name: 'set_move_longitudinal',
    description: 'W/S movement. Persistent until the next value.',
    required: ['move_longitudinal'],
    properties: {
      move_longitudinal: {
        type: 'string',
        enum: ['idle', 'forward', 'backward'],
      },
    },
  },
  {
    name: 'set_move_lateral',
    description: 'A/D movement. Persistent until the next value.',
    required: ['move_lateral'],
    properties: {
      move_lateral: { type: 'string', enum: ['idle', 'left', 'right'] },
    },
  },
  {
    name: 'set_look_horizontal',
    description: 'Yaw (look left/right).',
    required: ['look_horizontal'],
    properties: {
      look_horizontal: { type: 'string', enum: ['idle', 'left', 'right'] },
    },
  },
  {
    name: 'set_look_vertical',
    description: 'Pitch (look up/down).',
    required: ['look_vertical'],
    properties: {
      look_vertical: { type: 'string', enum: ['idle', 'up', 'down'] },
    },
  },
  {
    name: 'set_rotation_speed_deg',
    description: 'Camera rotation speed when a look axis is active.',
    required: ['rotation_speed_deg'],
    properties: {
      rotation_speed_deg: { type: 'number', minimum: 0, maximum: 30 },
    },
  },
  {
    name: 'set_camera_pose',
    description:
      'Directed camera-pose deltas. Can augment or replace the look axes.',
    properties: {
      pose: {
        type: 'object',
        additionalProperties: { type: 'number' },
        description: 'Per-frame motion deltas as documented by the model.',
      },
    },
  },
  {
    name: 'set_attn_window',
    description: 'Attention-window control for the generation loop.',
  },
  {
    name: 'set_kv_cache_reset',
    description: 'Configure KV-cache reset behaviour.',
  },
  {
    name: 'trigger_kv_cache_reset',
    description: 'Trigger a KV-cache reset on the next chunk.',
  },
  ...playbackCommands(),
]

const X2_COMMANDS: Array<CommandDef> = [
  promptCommand(
    'Editing instruction. Generation starts once a non-empty prompt is set and source frames arrive — there is no start command.',
  ),
  imageCommand(
    'set_reference_image',
    'image',
    'Reference image for character/object swaps. Replacing it mid-run restarts the stream.',
  ),
  {
    name: 'set_pointer',
    description: 'Drag pointer that steers the edited subject.',
    properties: {
      x: { type: 'number' },
      y: { type: 'number' },
      active: { type: 'boolean' },
    },
  },
  {
    name: 'set_pointer_x',
    description: 'Set the pointer X coordinate.',
    required: ['x'],
    properties: { x: { type: 'number' } },
  },
  {
    name: 'set_pointer_y',
    description: 'Set the pointer Y coordinate.',
    required: ['y'],
    properties: { y: { type: 'number' } },
  },
  {
    name: 'set_pointer_active',
    description: 'Whether the drag pointer is held.',
    required: ['active'],
    properties: { active: { type: 'boolean' } },
  },
  {
    name: 'set_keep_backlog',
    description: 'Latency vs smoothness policy, applied at the next block.',
    required: ['keep_backlog'],
    properties: { keep_backlog: { type: 'boolean' } },
  },
  {
    name: 'reset',
    description: 'Stop generation and clear prompt, image, and pointer.',
  },
]

const FAST_H3_COMMANDS: Array<CommandDef> = [
  {
    name: 'enqueue',
    description:
      'Append a clip to the playout row. Builds run down the row; play starts a built clip.',
    required: ['prompt'],
    properties: {
      prompt: { type: 'string' },
      starting_frame: {
        ...fileRef,
        description: 'Optional still that opens the clip.',
      },
      continue_from_clip_id: {
        type: 'string',
        description: 'Chain this clip from another clip’s last frame.',
      },
    },
  },
  {
    name: 'move',
    description: 'Reorder a clip in the row.',
    properties: {
      clip_id: { type: 'string' },
      index: { type: 'integer', minimum: 0 },
    },
  },
  {
    name: 'play',
    description:
      'Play a built clip. Omit clip_id to play the next built clip in the row.',
    properties: { clip_id: { type: 'string' } },
  },
  {
    name: 'pop',
    description: 'Remove a clip from the row.',
    properties: { clip_id: { type: 'string' } },
  },
  { name: 'stop', description: 'Stop the currently playing clip.' },
  { name: 'get_queue', description: 'Read the current clip row.' },
  {
    name: 'set_autoplay',
    description: 'Start the next built clip automatically when one finishes.',
    required: ['autoplay'],
    properties: { autoplay: { type: 'boolean' } },
  },
  {
    name: 'set_clip_seconds',
    description: 'Default clip length snapshotted by each enqueue.',
    required: ['clip_seconds'],
    properties: { clip_seconds: { type: 'number', minimum: 0 } },
  },
  seedCommand(),
  {
    name: 'set_canvas',
    description:
      'Session canvas / aspect. Default at launch is 1344×768 (16:9).',
    properties: {
      width: { type: 'integer' },
      height: { type: 'integer' },
    },
  },
  {
    name: 'set_flush_on_clip_end',
    description: 'Whether to flush generation state when a clip ends.',
    required: ['flush_on_clip_end'],
    properties: { flush_on_clip_end: { type: 'boolean' } },
  },
  { name: 'reset', description: 'Clear the row and session defaults.' },
  { name: 'get_state', description: 'Request a state_update snapshot.' },
]

const LONGLIVE_COMMANDS: Array<CommandDef> = [
  {
    name: 'set_shot',
    description:
      'Set the opening shot, or queue a soft transition that keeps the scene (same 48-chunk budget).',
    required: ['prompt'],
    properties: { prompt: { type: 'string' } },
  },
  {
    name: 'scene_cut',
    description:
      'Hard cut to a new scene: purges memory and starts a fresh 48-chunk budget.',
    required: ['prompt'],
    properties: { prompt: { type: 'string' } },
  },
  {
    name: 'schedule_shot',
    description: 'Plant a soft shot at a specific session_chunk.',
    required: ['prompt', 'session_chunk'],
    properties: {
      prompt: { type: 'string' },
      session_chunk: { type: 'integer', minimum: 0 },
    },
  },
  {
    name: 'schedule_scene_cut',
    description: 'Plant a hard cut at a specific session_chunk.',
    required: ['prompt', 'session_chunk'],
    properties: {
      prompt: { type: 'string' },
      session_chunk: { type: 'integer', minimum: 0 },
    },
  },
  seedCommand(),
  ...playbackCommands(),
]

const SANA_COMMANDS: Array<CommandDef> = [
  {
    name: 'set_mode',
    description:
      'Input source: live camera or uploaded file. Send with start as a pair.',
    required: ['mode'],
    properties: { mode: { type: 'string', enum: ['live', 'file'] } },
  },
  imageCommand(
    'set_video',
    'video',
    'Uploaded clip as the source (file mode). At least 33 frames.',
  ),
  promptCommand(
    'Edit prompt. Optional — with none the model streams a near-reconstruction of the source.',
  ),
  seedCommand(),
  {
    name: 'set_anchor_interval',
    description: 'Re-ground generation every N chunks to limit drift. 0 = off.',
    required: ['anchor_interval'],
    properties: {
      anchor_interval: { type: 'integer', minimum: 0, default: 0 },
    },
  },
  ...playbackCommands(),
]

const LTX_COMMANDS: Array<CommandDef> = [
  imageCommand(
    'set_avatar_image',
    'avatar_image',
    'Avatar photo that locks identity for the take (required before start).',
  ),
  {
    name: 'set_script',
    description: 'Spoken script (required before start).',
    required: ['script'],
    properties: { script: { type: 'string' } },
  },
  promptCommand(
    'Scene/delivery prompt: tone, energy, and setting, independent of the words.',
  ),
  {
    name: 'set_wpm',
    description: 'Speech rate. Take length defaults to script length / wpm.',
    required: ['wpm'],
    properties: { wpm: { type: 'number', minimum: 1 } },
  },
  {
    name: 'set_duration_seconds',
    description: 'Take length. Clamped to 4–300 seconds.',
    required: ['duration_seconds'],
    properties: {
      duration_seconds: { type: 'number', minimum: 4, maximum: 300 },
    },
  },
  seedCommand(),
  ...playbackCommands([
    { name: 'stop', description: 'Stop the current take.' },
  ]),
]

const VISKO_COMMANDS: Array<CommandDef> = [
  promptCommand(
    'Scene prompt. Mid-run changes morph at the next 33-frame chunk boundary (~1.8s).',
  ),
  {
    name: 'set_audio_prompt',
    description: 'Optional prompt for the picture-driven audio track.',
    required: ['audio_prompt'],
    properties: { audio_prompt: { type: 'string' } },
  },
  imageCommand(
    'set_image',
    'image',
    'Optional starting image that anchors the opening frame.',
  ),
  seedCommand(),
  {
    name: 'set_resolution',
    description:
      'Delivery upscale from the native 832×480 raster. Use values from state.available_resolutions.',
    required: ['resolution'],
    properties: {
      resolution: { type: 'string', enum: ['1080p', '2k', '4k'] },
    },
  },
  {
    name: 'set_audio_enabled',
    description: 'Toggle sound compute. Picture-driven audio is on by default.',
    required: ['audio_enabled'],
    properties: { audio_enabled: { type: 'boolean' } },
  },
  ...playbackCommands(),
]

const HAPPY_OYSTER_COMMANDS: Array<CommandDef> = [
  {
    name: 'create_world',
    description:
      'Build a new world for the connected experience (adventure or directing).',
    required: ['prompt'],
    properties: {
      prompt: { type: 'string' },
      perspective: {
        type: 'string',
        enum: ['first_person', 'third_person'],
      },
      resolution: { type: 'string', enum: ['480p', '720p'] },
      narrative: { type: 'string' },
      image: fileRef,
    },
  },
  {
    name: 'attach_world',
    description: 'Reopen an existing world of the same experience.',
    required: ['encrypted_world_id'],
    properties: { encrypted_world_id: { type: 'string' } },
  },
  {
    name: 'start_travel',
    description:
      'Begin the live world stream. Adventure lasts up to 2 minutes; directing up to 3.',
  },
  {
    name: 'end_travel_session',
    description: 'End the current travel without disconnecting.',
  },
  {
    name: 'move',
    description: 'Adventure: held movement control.',
    properties: { direction: { type: 'string' } },
  },
  {
    name: 'look',
    description: 'Adventure: look axis.',
    properties: { direction: { type: 'string' } },
  },
  {
    name: 'interact',
    description: 'Adventure: interact with the current target.',
  },
  { name: 'hold', description: 'Adventure: hold the current interaction.' },
  {
    name: 'release',
    description: 'Adventure: release held movement/interaction.',
  },
  { name: 'stop', description: 'Adventure: stop movement.' },
  {
    name: 'instruct',
    description: 'Directing: steer the story with a text instruction.',
    required: ['instruction'],
    properties: { instruction: { type: 'string' } },
  },
  { name: 'pause', description: 'Directing: pause the take.' },
  { name: 'resume', description: 'Directing: resume the take.' },
  { name: 'rewind', description: 'Directing: rewind the take.' },
]

const REACTOR_MODELS: Array<ReactorModel> = [
  {
    pricingName: 'fast-h3',
    rawId: 'reactor/fast-h3',
    displayName: 'FastH3',
    commands: FAST_H3_COMMANDS,
  },
  {
    pricingName: 'helios',
    rawId: 'reactor/helios',
    displayName: 'Helios',
    commands: HELIOS_COMMANDS,
  },
  {
    pricingName: 'lingbot',
    rawId: 'reactor/lingbot',
    displayName: 'LingBot',
    commands: LINGBOT_COMMANDS,
  },
  {
    pricingName: 'lingbot-world-2',
    rawId: 'reactor/lingbot-world-2',
    displayName: 'LingBot World 2',
    commands: LINGBOT_WORLD_2_COMMANDS,
  },
  {
    pricingName: 'longlive-v2',
    rawId: 'reactor/longlive-v2',
    displayName: 'LongLive-2.0',
    commands: LONGLIVE_COMMANDS,
  },
  {
    pricingName: 'ltx2',
    rawId: 'reactor/ltx2',
    displayName: 'LTX',
    commands: LTX_COMMANDS,
  },
  {
    pricingName: 'sana-streaming',
    rawId: 'reactor/sana-streaming',
    displayName: 'SANA-Streaming',
    commands: SANA_COMMANDS,
  },
  {
    pricingName: 'visko-orbis-stable',
    rawId: 'reactor/visko-orbis-stable',
    displayName: 'Visko Orbis Stable',
    commands: VISKO_COMMANDS,
  },
  {
    pricingName: 'visko-orbis-dynamic',
    rawId: 'reactor/visko-orbis-dynamic',
    displayName: 'Visko Orbis Dynamic',
    commands: VISKO_COMMANDS,
  },
  {
    pricingName: 'x2',
    rawId: 'x2',
    displayName: 'X2',
    commands: X2_COMMANDS,
  },
  {
    pricingName: 'happy-oyster-adventure',
    rawId: 'reactor/happy-oyster-adventure',
    displayName: 'HappyOyster Adventure',
    commands: HAPPY_OYSTER_COMMANDS,
  },
  {
    pricingName: 'happy-oyster-director',
    rawId: 'reactor/happy-oyster-director',
    displayName: 'HappyOyster Directing',
    commands: HAPPY_OYSTER_COMMANDS,
  },
]

/** Billing parent row — not a connect slug. */
const SKIP_PRICING_NAMES = new Set(['happy-oyster'])

const MODEL_BY_PRICING = new Map(
  REACTOR_MODELS.map((model) => [model.pricingName, model]),
)
const MODEL_BY_RAW_ID = new Map(
  REACTOR_MODELS.map((model) => [model.rawId, model]),
)

function modelPath(rawId: string): string {
  return `/models/${rawId}`
}

function jsonBody(schema: Schema) {
  return {
    required: true,
    content: {
      'application/json': { schema },
    },
  }
}

function jsonResponse(description: string, schema: Schema) {
  return {
    description,
    content: {
      'application/json': { schema },
    },
  }
}

function commandDataSchema(command: CommandDef): Schema {
  const properties = command.properties ?? {}
  const required = command.required ?? []
  return {
    type: 'object',
    description: command.description,
    ...(required.length > 0 ? { required } : {}),
    properties,
    additionalProperties: false,
  }
}

function sendCommandEnvelope(commands: Array<CommandDef>): Schema {
  return {
    description:
      'WebRTC sendCommand envelope: `{ command, data }` over the session data channel. The runtime’s own OpenAPI (fetched after connect via requestSchema) uses POST /events/<command>.',
    oneOf: commands.map((command) => ({
      type: 'object',
      required: ['command', 'data'],
      additionalProperties: false,
      properties: {
        command: {
          type: 'string',
          const: command.name,
          description: command.description,
        },
        data: commandDataSchema(command),
      },
    })),
  }
}

function fileRefSchema(): Schema {
  return {
    type: 'object',
    description:
      'Returned by uploadFile() / upload_file(). Pass into sendCommand data. JS fields are camelCase; the Python SDK uses upload_id / mime_type.',
    required: ['uploadId', 'name', 'mimeType', 'size'],
    properties: {
      uploadId: { type: 'string' },
      name: { type: 'string' },
      mimeType: { type: 'string' },
      size: { type: 'integer', minimum: 0 },
    },
  }
}

function tokenRequestSchema(): Schema {
  return {
    type: 'object',
    description:
      'Mint a JWT. Always pass authorization_details to scope the token to named models; omitting it mints an unscoped token that must not go to a browser.',
    properties: {
      expires_after: {
        type: 'integer',
        minimum: 1,
        maximum: 21600,
        description:
          'Lifetime in seconds. Default 3600; server ceiling 6 hours (silently clamped).',
      },
      authorization_details: {
        type: 'array',
        minItems: 1,
        items: { $ref: '#/components/schemas/AuthorizationDetail' },
      },
    },
  }
}

function authorizationDetailSchema(): Schema {
  return {
    type: 'object',
    required: ['type', 'resources'],
    properties: {
      type: { type: 'string', const: 'session' },
      resources: {
        type: 'object',
        required: ['models'],
        properties: {
          models: {
            type: 'object',
            required: ['match'],
            properties: {
              match: {
                type: 'array',
                minItems: 1,
                items: { type: 'string' },
                description: 'Connect slugs this token may start sessions for.',
              },
            },
          },
          sessions: {
            type: 'object',
            properties: {
              bind: {
                type: 'array',
                minItems: 1,
                items: { type: 'string' },
                description: 'Existing session ids this token may adopt.',
              },
            },
          },
        },
      },
      constraints: {
        type: 'object',
        properties: {
          max_sessions: {
            type: 'integer',
            minimum: 1,
            maximum: 500,
            default: 5,
          },
          max_session_duration_seconds: {
            type: 'integer',
            minimum: 1,
            maximum: 86400,
          },
        },
      },
    },
  }
}

function sessionRequestSchema(): Schema {
  return {
    type: 'object',
    required: ['model'],
    properties: {
      model: {
        type: 'string',
        description:
          'Connect slug from the model’s own docs page, e.g. reactor/helios or x2.',
      },
    },
  }
}

function sessionResponseSchema(): Schema {
  return {
    type: 'object',
    description:
      'Session resource as returned by the platform (snake_case wire shape).',
    properties: {
      session_id: { type: 'string' },
      state: { type: 'string' },
      model: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          version: { type: 'string' },
        },
      },
      cluster: { type: 'string' },
      capabilities: {
        type: 'object',
        properties: {
          protocol_version: { type: 'string' },
          emission_fps: { type: 'number' },
          tracks: { type: 'array', items: { type: 'object' } },
          commands: { type: 'array', items: { type: 'object' } },
        },
      },
    },
    additionalProperties: true,
  }
}

function sendCommandResponseSchema(): Schema {
  return {
    type: 'object',
    description:
      'Correlated sendCommand reply. `undefined`/empty means the handler acknowledged with no body. Application messages also arrive unsolicited as `{ type, data }`.',
    properties: {
      type: { type: 'string' },
      data: { type: 'object', additionalProperties: true },
    },
  }
}

function reactorSpec(): OpenApiDocument {
  const paths: Record<string, Record<string, OpenApiOperation>> = {
    '/tokens': {
      post: {
        operationId: 'createToken',
        summary: 'Mint a session-scoped JWT',
        tags: ['platform'],
        requestBody: jsonBody({ $ref: '#/components/schemas/TokenRequest' }),
        responses: {
          '200': jsonResponse('JWT and expiry', {
            $ref: '#/components/schemas/TokenResponse',
          }),
        },
      },
    },
    '/sessions': {
      post: {
        operationId: 'createSession',
        summary: 'Create a realtime generation session',
        tags: ['video'],
        requestBody: jsonBody({ $ref: '#/components/schemas/SessionRequest' }),
        responses: {
          '200': jsonResponse('Session accepted', {
            $ref: '#/components/schemas/SessionResponse',
          }),
        },
      },
    },
  }

  for (const model of REACTOR_MODELS) {
    const path = modelPath(model.rawId)
    paths[path] = {
      post: {
        operationId: `sendCommand_${model.pricingName.replace(/-/g, '_')}`,
        summary: `sendCommand envelope for ${model.displayName}`,
        description: `Drive ${model.rawId} over the WebRTC data channel after POST /sessions. Not an HTTP path on api.reactor.inc.`,
        tags: ['video'],
        requestBody: jsonBody(sendCommandEnvelope(model.commands)),
        responses: {
          '200': jsonResponse('Command reply', {
            $ref: '#/components/schemas/SendCommandResponse',
          }),
        },
      },
    }
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Reactor API',
      version: 'docs-derived',
      description:
        'Hand-written from https://docs.reactor.inc. No published OpenAPI. Real-time world/video models: mint a JWT (POST /tokens), open a session (POST /sessions), then sendCommand over WebRTC. Per-model paths under /models/{slug} are the command envelopes, not HTTP routes.',
    },
    servers: [{ url: REACTOR_API_BASE, description: 'Reactor Platform API' }],
    security: [{ apiKey: [] }],
    paths,
    components: {
      securitySchemes: {
        apiKey: {
          type: 'apiKey',
          in: 'header',
          name: 'Reactor-API-Key',
          description:
            'API key starting with `rk_`. Browser clients must exchange it for a session-scoped JWT via POST /tokens and never see the key. Platform catalog endpoints (GET /pricing) are public; GET /models uses `Authorization: Bearer`.',
        },
      },
      schemas: {
        FileRef: fileRefSchema(),
        AuthorizationDetail: authorizationDetailSchema(),
        TokenRequest: tokenRequestSchema(),
        TokenResponse: {
          type: 'object',
          properties: {
            jwt: { type: 'string' },
            expires_at: {
              type: 'integer',
              description:
                'Unix epoch seconds. Always check — the server may clamp expires_after.',
            },
          },
        },
        SessionRequest: sessionRequestSchema(),
        SessionResponse: sessionResponseSchema(),
        SendCommandResponse: sendCommandResponseSchema(),
      },
    },
  }
}

function classify(path: string): Activity | null {
  const bare = path.split('?')[0] ?? path
  if (bare === '/sessions' || bare.startsWith('/models/')) return 'video'
  return null
}

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const spec = reactorSpec()
  return {
    specs: [spec],
    sources: [{ url: REACTOR_DOCS_URL, hash: await contentHash(spec) }],
    outputStrategy: 'post-200',
  }
}

interface PricingRate {
  amount_per_sec?: number
  unit?: string
  denomination?: string
}

interface PricingModel {
  id?: string
  name?: string
  rate?: PricingRate
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parsePricing(body: unknown): Array<PricingModel> {
  if (!isRecord(body)) return []
  const models = body.models
  if (!Array.isArray(models)) return []
  return models.filter((row): row is PricingModel => isRecord(row))
}

function modelInfo(
  model: ReactorModel,
  extras?: { pricing?: unknown; upstreamId?: string },
): ModelInfo {
  return {
    rawId: model.rawId,
    displayName: model.displayName,
    activity: 'video',
    pricing: extras?.pricing ?? null,
    capabilities: {
      pricingName: model.pricingName,
      ...(extras?.upstreamId ? { upstreamId: extras.upstreamId } : {}),
    },
  }
}

function curatedCatalog(): Array<ModelInfo> {
  return REACTOR_MODELS.map((model) => modelInfo(model))
}

function catalogFromPricing(rows: Array<PricingModel>): Array<ModelInfo> {
  const seen = new Set<string>()
  const models: Array<ModelInfo> = []
  for (const row of rows) {
    const name = row.name
    if (typeof name !== 'string' || name.length === 0) continue
    if (SKIP_PRICING_NAMES.has(name)) continue
    const known = MODEL_BY_PRICING.get(name)
    const model: ReactorModel = known ?? {
      pricingName: name,
      rawId: name.includes('/') ? name : `reactor/${name}`,
      displayName: name,
      commands: [],
    }
    if (seen.has(model.rawId)) continue
    seen.add(model.rawId)
    models.push(
      modelInfo(model, {
        pricing: row.rate ?? null,
        upstreamId: typeof row.id === 'string' ? row.id : undefined,
      }),
    )
  }
  for (const model of REACTOR_MODELS) {
    if (seen.has(model.rawId)) continue
    seen.add(model.rawId)
    models.push(modelInfo(model))
  }
  return models
}

async function listModels(_env: ProviderSecrets): Promise<ListModelsResult> {
  try {
    const body = await fetchJson(REACTOR_PRICING_URL)
    const rows = parsePricing(body)
    if (rows.length === 0) return { models: curatedCatalog() }
    return { models: catalogFromPricing(rows) }
  } catch {
    return { models: curatedCatalog() }
  }
}

export const provider: ProviderConfig = {
  id: 'reactor',
  displayName: 'Reactor',
  authEnvVar: 'REACTOR_API_KEY',
  specSourceUrl: REACTOR_DOCS_URL,
  modelsEndpoint: REACTOR_PRICING_URL,
  defaultDerivation: 'docs-derived',
  specGrain: 'provider',
  connect: {
    servers: [{ url: REACTOR_API_BASE, description: 'Reactor Platform API' }],
    securitySchemes: {
      apiKey: {
        type: 'apiKey',
        in: 'header',
        name: 'Reactor-API-Key',
        description:
          'API key starting with `rk_`. Browser clients exchange it for a session-scoped JWT via POST /tokens.',
      },
    },
    security: [{ apiKey: [] }],
  },
  fetchSpec,
  listModels,
  classify,
  generationEndpointId: ({ rawId }) => {
    const known = MODEL_BY_RAW_ID.get(rawId) ?? MODEL_BY_PRICING.get(rawId)
    const slug = known?.rawId ?? rawId
    return modelPath(slug).replace(/^\//, '')
  },
}
