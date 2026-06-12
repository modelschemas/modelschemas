/**
 * Distills the composable controls out of a video-generation input schema:
 * which property holds the prompt, which enums constrain aspect ratio,
 * duration, and resolution — and at what path, so a request payload can be
 * assembled exactly the way the schema spells it.
 */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | Array<JsonValue>
  | { [key: string]: JsonValue }

export type JsonObject = { [key: string]: JsonValue }

export type SchemaNode = { readonly [key: string]: unknown }

function isNode(value: unknown): value is SchemaNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(node: SchemaNode, key: string): string | undefined {
  const value = node[key]
  return typeof value === 'string' ? value : undefined
}

function num(node: SchemaNode, key: string): number | undefined {
  const value = node[key]
  return typeof value === 'number' ? value : undefined
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true
  const kind = typeof value
  if (kind === 'string' || kind === 'number' || kind === 'boolean') return true
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (kind === 'object')
    return Object.values(value as object).every(isJsonValue)
  return false
}

function enumOf(node: SchemaNode): Array<JsonValue> | undefined {
  const values = node['enum']
  if (!Array.isArray(values)) return undefined
  const out = values.filter(isJsonValue)
  return out.length > 0 ? out : undefined
}

function resolveRef(node: SchemaNode, root: SchemaNode): SchemaNode {
  let current = node
  for (let hop = 0; hop < 8; hop++) {
    const ref = str(current, '$ref')
    if (ref === undefined || !ref.startsWith('#/$defs/')) return current
    const defs = root['$defs']
    const target = isNode(defs) ? defs[ref.slice('#/$defs/'.length)] : undefined
    if (!isNode(target)) return current
    current = target
  }
  return current
}

export interface PickOption {
  label: string
  value: JsonValue
  isDefault: boolean
}

export interface EnumControl {
  path: Array<string>
  options: Array<PickOption>
}

export type DurationControl =
  | { path: Array<string>; kind: 'enum'; options: Array<PickOption> }
  | {
      path: Array<string>
      kind: 'range'
      min?: number
      max?: number
      defaultValue?: number
    }

export interface VideoControls {
  promptPath: Array<string> | null
  /** `model` property pinned by the schema (single-value enum or const). */
  modelField: { path: Array<string>; value: JsonValue } | null
  aspect: EnumControl | null
  duration: DurationControl | null
  resolution: EnumControl | null
}

const PROMPT_KEYS = new Set(['prompt', 'text_prompt', 'text'])
const ASPECT_KEYS = new Set(['aspect_ratio', 'aspectratio', 'ratio'])
const DURATION_KEYS = new Set([
  'duration',
  'duration_seconds',
  'durationseconds',
  'seconds',
  'video_duration',
  'num_seconds',
  'video_length',
])
const RESOLUTION_KEYS = new Set(['resolution', 'video_resolution'])

function toOptions(node: SchemaNode): Array<PickOption> | undefined {
  const values = enumOf(node)
  if (values === undefined) return undefined
  const fallback = node['default']
  return values.map((value) => ({
    label: typeof value === 'string' ? value : JSON.stringify(value),
    value,
    isDefault: isJsonValue(fallback) && fallback === value,
  }))
}

export function extractVideoControls(schema: SchemaNode): VideoControls {
  const controls: VideoControls = {
    promptPath: null,
    modelField: null,
    aspect: null,
    duration: null,
    resolution: null,
  }

  const visit = (node: SchemaNode, path: Array<string>, depth: number) => {
    if (depth > 3) return
    const resolved = resolveRef(node, schema)
    const props = resolved['properties']
    if (!isNode(props)) return
    for (const [name, child] of Object.entries(props)) {
      if (!isNode(child)) continue
      const childNode = resolveRef(child, schema)
      const childPath = [...path, name]
      const lower = name.toLowerCase()

      if (controls.promptPath === null && PROMPT_KEYS.has(lower)) {
        controls.promptPath = childPath
      } else if (controls.modelField === null && lower === 'model') {
        const options = enumOf(childNode)
        const constant = childNode['const']
        const pinned =
          options?.length === 1
            ? options[0]
            : isJsonValue(constant)
              ? constant
              : undefined
        if (pinned !== undefined)
          controls.modelField = { path: childPath, value: pinned }
      } else if (controls.aspect === null && ASPECT_KEYS.has(lower)) {
        const options = toOptions(childNode)
        if (options !== undefined)
          controls.aspect = { path: childPath, options }
      } else if (controls.duration === null && DURATION_KEYS.has(lower)) {
        const options = toOptions(childNode)
        if (options !== undefined) {
          controls.duration = { path: childPath, kind: 'enum', options }
        } else {
          const min = num(childNode, 'minimum')
          const max = num(childNode, 'maximum')
          const defaultValue = num(childNode, 'default')
          if (min !== undefined || max !== undefined) {
            controls.duration = {
              path: childPath,
              kind: 'range',
              min,
              max,
              defaultValue,
            }
          }
        }
      } else if (controls.resolution === null && RESOLUTION_KEYS.has(lower)) {
        const options = toOptions(childNode)
        if (options !== undefined)
          controls.resolution = { path: childPath, options }
      }

      // Descend into nested objects (e.g. Gemini-style `parameters`).
      visit(childNode, childPath, depth + 1)
    }
  }

  visit(schema, [], 0)
  return controls
}

/** Immutably set a value at a nested object path. */
export function setAtPath(
  target: JsonObject,
  path: Array<string>,
  value: JsonValue,
): JsonObject {
  const [head, ...rest] = path
  if (head === undefined) return target
  if (rest.length === 0) return { ...target, [head]: value }
  const existing = target[head]
  const child =
    typeof existing === 'object' &&
    existing !== null &&
    !Array.isArray(existing)
      ? existing
      : {}
  return { ...target, [head]: setAtPath(child, rest, value) }
}

/** The option to use for the current selection: the previously chosen label
 * when this model also allows it, else the schema default, else the first. */
export function clampOption(
  options: Array<PickOption>,
  chosenLabel: string | null,
): PickOption | undefined {
  if (chosenLabel !== null) {
    const kept = options.find((option) => option.label === chosenLabel)
    if (kept !== undefined) return kept
  }
  return options.find((option) => option.isDefault) ?? options[0]
}
