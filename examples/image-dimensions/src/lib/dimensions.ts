/**
 * Distills "what dimensions can this image model produce?" out of an
 * arbitrary input JSON Schema. Works generically: it walks every property
 * (through $defs, anyOf/oneOf, and nested objects) looking for the
 * dimension vocabulary providers actually use — `size`/`image_size` enums,
 * `width`/`height` bounds, `aspect_ratio`/`aspectRatio`, `resolution`.
 */

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

function strEnum(node: SchemaNode): Array<string> | undefined {
  const values = node['enum']
  if (!Array.isArray(values)) return undefined
  const out = values.filter((v): v is string => typeof v === 'string')
  return out.length > 0 ? out : undefined
}

export interface SizeBox {
  label: string
  width: number
  height: number
  /** 'exact' parsed from WxH; 'preset' mapped from a documented preset name. */
  kind: 'exact' | 'preset'
  isDefault: boolean
}

export interface AspectBox {
  label: string
  ratio: number
  isDefault: boolean
}

export interface Bounds {
  minWidth?: number
  maxWidth?: number
  minHeight?: number
  maxHeight?: number
  defaultWidth?: number
  defaultHeight?: number
}

export interface DimensionReport {
  sizes: Array<SizeBox>
  aspects: Array<AspectBox>
  bounds: Bounds | null
  resolutions: Array<string>
  modelIds: Array<string>
  hasAny: boolean
}

/** FAL's documented named presets (fal.ai ImageSize), used only to draw
 * preset enums to scale. Unknown presets fall back to a 1:1 box. */
const PRESET_DIMS: Record<string, [number, number]> = {
  square_hd: [1024, 1024],
  square: [512, 512],
  portrait_4_3: [768, 1024],
  portrait_16_9: [576, 1024],
  landscape_4_3: [1024, 768],
  landscape_16_9: [1024, 576],
}

const SIZE_RE = /^(\d{2,5})\s*[x×]\s*(\d{2,5})$/i
const ASPECT_RE = /^(\d{1,2})\s*:\s*(\d{1,2})$/

/**
 * Google Discovery specs encode enum values as symbolic constants
 * (`ASPECT_RATIO_SIXTEEN_BY_NINE`, `IMAGE_SIZE_TWO_K`) rather than the
 * literal labels every other provider uses; map them back. `*_UNSPECIFIED`
 * sentinels are dropped before these run.
 */
const GOOGLE_NUMBER_WORDS: Record<string, number> = {
  ONE: 1,
  TWO: 2,
  THREE: 3,
  FOUR: 4,
  FIVE: 5,
  SIX: 6,
  SEVEN: 7,
  EIGHT: 8,
  NINE: 9,
  TEN: 10,
  SIXTEEN: 16,
  TWENTY_ONE: 21,
}

const GOOGLE_IMAGE_SIZES: Record<string, string> = {
  IMAGE_SIZE_FIVE_TWELVE: '512',
  IMAGE_SIZE_ONE_K: '1K',
  IMAGE_SIZE_TWO_K: '2K',
  IMAGE_SIZE_FOUR_K: '4K',
}

/** `ASPECT_RATIO_SIXTEEN_BY_NINE` → `16:9`; undefined when not symbolic. */
function googleAspectLabel(value: string): string | undefined {
  const match = /^ASPECT_RATIO_(.+)_BY_(.+)$/.exec(value)
  if (match?.[1] === undefined || match[2] === undefined) return undefined
  const w = GOOGLE_NUMBER_WORDS[match[1]]
  const h = GOOGLE_NUMBER_WORDS[match[2]]
  if (w === undefined || h === undefined) return undefined
  return `${String(w)}:${String(h)}`
}

function parseAspect(label: string): number | undefined {
  const match = ASPECT_RE.exec(label)
  if (match?.[1] === undefined || match[2] === undefined) return undefined
  const w = Number(match[1])
  const h = Number(match[2])
  return h > 0 ? w / h : undefined
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

const ASPECT_KEYS = new Set(['aspect_ratio', 'aspectratio', 'ratio'])
const SIZE_KEYS = new Set([
  'size',
  'image_size',
  'imagesize',
  'sampleimagesize',
])
const RESOLUTION_KEYS = new Set(['resolution', 'image_resolution'])

export function extractDimensions(schema: SchemaNode): DimensionReport {
  const report: DimensionReport = {
    sizes: [],
    aspects: [],
    bounds: null,
    resolutions: [],
    modelIds: [],
    hasAny: false,
  }
  const seenSizes = new Set<string>()
  const seenAspects = new Set<string>()

  const addSize = (label: string, isDefault: boolean) => {
    if (seenSizes.has(label)) return
    const exact = SIZE_RE.exec(label)
    if (exact?.[1] !== undefined && exact[2] !== undefined) {
      seenSizes.add(label)
      report.sizes.push({
        label,
        width: Number(exact[1]),
        height: Number(exact[2]),
        kind: 'exact',
        isDefault,
      })
      return
    }
    const preset = PRESET_DIMS[label]
    if (preset !== undefined) {
      seenSizes.add(label)
      report.sizes.push({
        label,
        width: preset[0],
        height: preset[1],
        kind: 'preset',
        isDefault,
      })
      return
    }
    const ratio = parseAspect(label)
    if (ratio !== undefined) {
      addAspect(label, isDefault)
      return
    }
    // Unrecognized symbolic size ('auto', provider-specific names): list it
    // as a named mode rather than inventing a rectangle for it.
    seenSizes.add(label)
    if (!report.resolutions.includes(label)) report.resolutions.push(label)
  }

  const addAspect = (label: string, isDefault: boolean) => {
    if (seenAspects.has(label)) return
    const ratio = parseAspect(label)
    if (ratio === undefined) return
    seenAspects.add(label)
    report.aspects.push({ label, ratio, isDefault })
  }

  const visit = (node: SchemaNode, name: string, depth: number) => {
    if (depth > 6) return
    const resolved = resolveRef(node, schema)
    const lower = name.toLowerCase()
    const options = strEnum(resolved)
    const fallback = str(resolved, 'default')

    if (lower === 'model' && options !== undefined) {
      for (const id of options)
        if (!report.modelIds.includes(id)) report.modelIds.push(id)
    } else if (ASPECT_KEYS.has(lower) && options !== undefined) {
      for (const option of options) {
        if (option.endsWith('_UNSPECIFIED')) continue
        addAspect(googleAspectLabel(option) ?? option, option === fallback)
      }
    } else if (RESOLUTION_KEYS.has(lower) && options !== undefined) {
      for (const option of options) {
        if (option.endsWith('_UNSPECIFIED')) continue
        if (!report.resolutions.includes(option))
          report.resolutions.push(option)
      }
    } else if (SIZE_KEYS.has(lower) && options !== undefined) {
      for (const option of options) {
        if (option.endsWith('_UNSPECIFIED')) continue
        addSize(GOOGLE_IMAGE_SIZES[option] ?? option, option === fallback)
      }
    } else if (lower === 'width' || lower === 'height') {
      const bounds: Bounds = report.bounds ?? {}
      const min = num(resolved, 'minimum')
      const max = num(resolved, 'maximum')
      const def = num(resolved, 'default')
      if (lower === 'width') {
        if (min !== undefined) bounds.minWidth = min
        if (max !== undefined) bounds.maxWidth = max
        if (def !== undefined) bounds.defaultWidth = def
      } else {
        if (min !== undefined) bounds.minHeight = min
        if (max !== undefined) bounds.maxHeight = max
        if (def !== undefined) bounds.defaultHeight = def
      }
      report.bounds = bounds
    }

    // Recurse: object properties, array items, anyOf/oneOf/allOf variants.
    const props = resolved['properties']
    if (isNode(props)) {
      for (const [childName, child] of Object.entries(props)) {
        if (isNode(child)) visit(child, childName, depth + 1)
      }
    }
    const items = resolved['items']
    if (isNode(items)) visit(items, name, depth + 1)
    for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
      const list = resolved[key]
      if (Array.isArray(list)) {
        for (const variant of list) {
          if (isNode(variant)) visit(variant, name, depth + 1)
        }
      }
    }
  }

  visit(schema, '', 0)

  report.hasAny =
    report.sizes.length > 0 ||
    report.aspects.length > 0 ||
    report.bounds !== null ||
    report.resolutions.length > 0
  return report
}
