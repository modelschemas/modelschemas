/**
 * Catalog-fact merge for issue #53: listing/docs first, then flags and
 * modalities walked from the bound generation request schema. Each stored
 * value keeps the winning rung. `generated` OpenAI-borrowed specs are
 * skipped — walking them would stamp OpenAI's tools onto DeepSeek etc.
 */
import type {
  Derivation,
  FactDerivation,
  FactSource,
  ModelFactSources,
  ModelInfo,
} from './types.ts'

const SCHEMA_RUNGS: ReadonlySet<string> = new Set([
  'upstream-spec',
  'generated',
  'probe-verified',
  'docs-derived',
])

/** OpenRouter `supported_parameters` names plus native extras we already store. */
const PROPERTY_TO_FLAG: Record<string, string> = {
  tools: 'tools',
  tool_choice: 'tool_choice',
  toolConfig: 'tool_choice',
  max_tokens: 'max_tokens',
  max_completion_tokens: 'max_tokens',
  max_output_tokens: 'max_tokens',
  maxOutputTokens: 'max_tokens',
  temperature: 'temperature',
  top_p: 'top_p',
  topP: 'top_p',
  top_k: 'top_k',
  topK: 'top_k',
  stop: 'stop',
  seed: 'seed',
  frequency_penalty: 'frequency_penalty',
  presence_penalty: 'presence_penalty',
  response_format: 'response_format',
  reasoning: 'reasoning',
  thinking: 'reasoning',
  include_reasoning: 'include_reasoning',
  reasoning_effort: 'reasoning_effort',
  effort: 'reasoning_effort',
  structured_outputs: 'structured_outputs',
  responseSchema: 'structured_outputs',
  responseMimeType: 'response_format',
}

const NESTED_CONTAINERS = new Set([
  'generationConfig',
  'generation_config',
  'output_config',
  'thinking',
  'reasoning',
])

const INPUT_MODALITY: Record<string, string> = {
  image: 'image',
  image_url: 'image',
  images: 'image',
  input_image: 'image',
  inline_data: 'image',
  input_audio: 'audio',
  audio: 'audio',
  video: 'video',
  input_video: 'video',
  file: 'file',
  input_file: 'file',
  document: 'file',
  pdf: 'file',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is Array<string> {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function emptySources(sources: ModelFactSources): boolean {
  return (
    sources.contextWindow === undefined &&
    sources.maxOutput === undefined &&
    sources.modalities === undefined &&
    sources.pricing === undefined &&
    (sources.capabilities === undefined ||
      Object.keys(sources.capabilities).length === 0)
  )
}

export function listingSources(info: ModelInfo): ModelFactSources {
  if (info.factSources) return info.factSources
  const src: FactSource = { derivation: 'listing' }
  const out: ModelFactSources = {}
  if (info.contextWindow != null) out.contextWindow = src
  if (info.maxOutput != null) out.maxOutput = src
  if (info.modalities != null) out.modalities = src
  if (info.pricing != null) out.pricing = src
  if (isStringArray(info.capabilities) && info.capabilities.length > 0) {
    out.capabilities = Object.fromEntries(
      info.capabilities.map((flag) => [flag, src]),
    )
  }
  return out
}

/** Attach `docs-derived` provenance to every stated fact on a docs page. */
export function tagDocsFacts(
  facts: Pick<
    ModelInfo,
    'contextWindow' | 'maxOutput' | 'modalities' | 'capabilities'
  >,
  sourceUrl: string,
): ModelFactSources {
  const src = (path: string): FactSource => ({
    derivation: 'docs-derived',
    sourceUrl,
    path,
  })
  const out: ModelFactSources = {}
  if (facts.contextWindow != null) out.contextWindow = src('contextWindow')
  if (facts.maxOutput != null) out.maxOutput = src('maxOutput')
  if (facts.modalities != null) out.modalities = src('modalities')
  if (isStringArray(facts.capabilities) && facts.capabilities.length > 0) {
    out.capabilities = Object.fromEntries(
      facts.capabilities.map((flag) => [flag, src(`capabilities.${flag}`)]),
    )
  }
  return out
}

function resolveRef(
  root: Record<string, unknown>,
  node: unknown,
  depth = 0,
): unknown {
  if (depth > 8 || !isRecord(node) || typeof node.$ref !== 'string') return node
  const ref = node.$ref
  if (!ref.startsWith('#/$defs/')) return node
  const defs = isRecord(root.$defs) ? root.$defs : {}
  const name = ref.slice('#/$defs/'.length)
  const target = defs[name]
  return target === undefined ? node : resolveRef(root, target, depth + 1)
}

function propertiesOf(
  root: Record<string, unknown>,
  node: unknown,
): Record<string, unknown> {
  const resolved = resolveRef(root, node)
  if (!isRecord(resolved)) return {}
  const own = isRecord(resolved.properties) ? resolved.properties : {}
  const out: Record<string, unknown> = { ...own }
  const combiners = [resolved.allOf, resolved.anyOf, resolved.oneOf]
  for (const list of combiners) {
    if (!Array.isArray(list)) continue
    for (const item of list) {
      Object.assign(out, propertiesOf(root, item))
    }
  }
  return out
}

export interface SchemaWalk {
  flags: Array<string>
  modalities: { input: Array<string>; output: Array<string> } | null
  sources: ModelFactSources
}

/**
 * Walk a bundled request schema for OpenRouter parameter names and input
 * modalities. `generated` schemas are skipped by the caller.
 */
export function walkRequestSchema(
  schema: unknown,
  meta: {
    derivation: FactDerivation
    endpointId: string
    sourceUrl?: string | null
    sourceHash?: string | null
    fetchedAt?: number
    activity?: ModelInfo['activity']
  },
): SchemaWalk | null {
  if (!isRecord(schema)) return null
  const props = propertiesOf(schema, schema)
  const flags = new Map<string, string>()
  const note = (name: string, pointer: string) => {
    const flag = PROPERTY_TO_FLAG[name]
    if (flag && !flags.has(flag)) flags.set(flag, pointer)
  }
  for (const [name, node] of Object.entries(props)) {
    note(name, `/properties/${name}`)
    if (!NESTED_CONTAINERS.has(name)) continue
    const nested = propertiesOf(schema, node)
    for (const nestedName of Object.keys(nested)) {
      note(nestedName, `/properties/${name}/properties/${nestedName}`)
    }
  }
  if (flags.has('response_format')) {
    const rf = resolveRef(schema, props.response_format)
    const rfProps = propertiesOf(schema, rf)
    if ('json_schema' in rfProps || 'schema' in rfProps) {
      flags.set('structured_outputs', '/properties/response_format')
    }
  }
  if (flags.has('structured_outputs') && !flags.has('response_format')) {
    flags.set('response_format', '/properties/responseSchema')
  }

  const input = new Set<string>()
  const visitKeys = (node: unknown, depth: number) => {
    if (depth > 6) return
    const resolved = resolveRef(schema, node)
    if (Array.isArray(resolved)) {
      for (const item of resolved) visitKeys(item, depth + 1)
      return
    }
    if (!isRecord(resolved)) return
    for (const key of Object.keys(resolved)) {
      const modality = INPUT_MODALITY[key]
      if (modality) input.add(modality)
    }
    const inner = propertiesOf(schema, resolved)
    for (const key of Object.keys(inner)) {
      const modality = INPUT_MODALITY[key]
      if (modality) input.add(modality)
      visitKeys(inner[key], depth + 1)
    }
    visitKeys(resolved.items, depth + 1)
    visitKeys(resolved.anyOf, depth + 1)
    visitKeys(resolved.oneOf, depth + 1)
    visitKeys(resolved.allOf, depth + 1)
    visitKeys(resolved.$defs, depth + 1)
  }
  visitKeys(schema, 0)
  if (input.size > 0 && (meta.activity === 'chat' || meta.activity == null)) {
    input.add('text')
  }

  const source = (path: string): FactSource => ({
    derivation: meta.derivation,
    endpointId: meta.endpointId,
    path,
    ...(meta.sourceUrl ? { sourceUrl: meta.sourceUrl } : {}),
    ...(meta.sourceHash ? { sourceHash: meta.sourceHash } : {}),
    ...(meta.fetchedAt !== undefined ? { fetchedAt: meta.fetchedAt } : {}),
  })

  const flagList = [...flags.keys()]
  const sources: ModelFactSources = {}
  if (flagList.length > 0) {
    sources.capabilities = Object.fromEntries(
      [...flags].map(([flag, path]) => [flag, source(path)]),
    )
  }
  let modalities: SchemaWalk['modalities'] = null
  if (input.size > 0) {
    const output =
      meta.activity === 'image'
        ? ['image']
        : meta.activity === 'audio'
          ? ['audio']
          : meta.activity === 'video'
            ? ['video']
            : meta.activity === 'embeddings'
              ? ['embeddings']
              : ['text']
    modalities = { input: [...input], output }
    sources.modalities = source('modalities')
  }
  if (flagList.length === 0 && modalities === null) return null
  return { flags: flagList, modalities, sources }
}

export interface MergedFacts {
  contextWindow: number | null
  maxOutput: number | null
  modalities: unknown
  pricing: unknown
  capabilities: unknown
  factSources: ModelFactSources | null
}

/**
 * Listing/docs win on a field they stated. Schema fills remaining
 * capability flags and null modalities. Host-native capability objects
 * are left alone.
 */
export function mergeListingAndSchema(
  listing: ModelInfo,
  walk: SchemaWalk | null,
): MergedFacts {
  const listed = listingSources(listing)
  const capabilitiesIsObject =
    listing.capabilities !== null &&
    listing.capabilities !== undefined &&
    isRecord(listing.capabilities) &&
    !Array.isArray(listing.capabilities)

  let capabilities: unknown = listing.capabilities ?? null
  const capSources: Record<string, FactSource> = {
    ...(listed.capabilities ?? {}),
  }
  if (!capabilitiesIsObject && walk && walk.flags.length > 0) {
    const have = new Set(isStringArray(capabilities) ? capabilities : [])
    const added: Array<string> = []
    for (const flag of walk.flags) {
      if (have.has(flag)) continue
      have.add(flag)
      added.push(flag)
      const src = walk.sources.capabilities?.[flag]
      if (src) capSources[flag] = src
    }
    capabilities = have.size > 0 ? [...have] : null
  }

  const modalities =
    listing.modalities != null ? listing.modalities : (walk?.modalities ?? null)
  const sources: ModelFactSources = { ...listed }
  if (listing.modalities == null && walk?.sources.modalities) {
    sources.modalities = walk.sources.modalities
  }
  if (Object.keys(capSources).length > 0 && !capabilitiesIsObject) {
    sources.capabilities = capSources
  }

  return {
    contextWindow: listing.contextWindow ?? null,
    maxOutput: listing.maxOutput ?? null,
    modalities,
    pricing: listing.pricing ?? null,
    capabilities,
    factSources: emptySources(sources) ? null : sources,
  }
}

export function schemaRung(
  derivation: Derivation | null,
): FactDerivation | null {
  if (derivation === null) return 'upstream-spec'
  if (derivation === 'generated') return null
  if (SCHEMA_RUNGS.has(derivation)) return derivation
  return null
}

export interface FactDiscrepancy {
  field: string
  ours: unknown
  openrouter: unknown
  oursDerivation: FactDerivation | null
  openrouterId: string
}

const OPENROUTER_AUTHOR: Record<string, string> = {
  openai: 'openai',
  anthropic: 'anthropic',
  gemini: 'google',
  grok: 'x-ai',
  mistral: 'mistralai',
  groq: 'groq',
  cohere: 'cohere',
  together: 'together',
  deepseek: 'deepseek',
  perplexity: 'perplexity',
  moonshot: 'moonshotai',
  fireworks: 'fireworks',
  cerebras: 'cerebras',
  novita: 'novita',
  jina: 'jina',
  sambanova: 'sambanova',
  hyperbolic: 'hyperbolic',
}

export function openRouterJoinIds(
  providerId: string,
  rawId: string,
): Array<string> {
  const author = OPENROUTER_AUTHOR[providerId]
  if (!author) return []
  const ids = [`${author}/${rawId}`]
  const undated = rawId.replace(/-\d{4}-\d{2}-\d{2}$|-\d{8}$/, '')
  if (undated !== rawId) ids.push(`${author}/${undated}`)
  return ids
}

function sortedStrings(value: unknown): Array<string> | null {
  if (!isStringArray(value)) return null
  return [...value].sort()
}

function capDerivation(
  sources: ModelFactSources | null,
  flag: string,
): FactDerivation | null {
  return sources?.capabilities?.[flag]?.derivation ?? null
}

/** First-party vs OpenRouter. Objects (FAL/etc) are not compared as flags. */
export function factDiscrepancies(
  ours: {
    contextWindow: unknown
    maxOutput: unknown
    modalities: unknown
    capabilities: unknown
    factSources: ModelFactSources | null
  },
  openrouter: {
    rawId: string
    contextWindow: unknown
    maxOutput: unknown
    modalities: unknown
    capabilities: unknown
  },
): Array<FactDiscrepancy> {
  const out: Array<FactDiscrepancy> = []
  const push = (
    field: string,
    oursValue: unknown,
    theirs: unknown,
    oursDerivation: FactDerivation | null,
  ) => {
    out.push({
      field,
      ours: oursValue,
      openrouter: theirs,
      oursDerivation,
      openrouterId: openrouter.rawId,
    })
  }
  if (ours.contextWindow !== openrouter.contextWindow) {
    push(
      'contextWindow',
      ours.contextWindow,
      openrouter.contextWindow,
      ours.factSources?.contextWindow?.derivation ?? null,
    )
  }
  if (ours.maxOutput !== openrouter.maxOutput) {
    push(
      'maxOutput',
      ours.maxOutput,
      openrouter.maxOutput,
      ours.factSources?.maxOutput?.derivation ?? null,
    )
  }
  const oursCaps = sortedStrings(ours.capabilities)
  const theirCaps = sortedStrings(openrouter.capabilities)
  if (oursCaps !== null && theirCaps !== null) {
    const theirSet = new Set(theirCaps)
    const oursSet = new Set(oursCaps)
    for (const flag of oursCaps) {
      if (!theirSet.has(flag)) {
        push(
          `capabilities.${flag}`,
          true,
          false,
          capDerivation(ours.factSources, flag),
        )
      }
    }
    for (const flag of theirCaps) {
      if (!oursSet.has(flag)) {
        push(`capabilities.${flag}`, false, true, null)
      }
    }
  }
  return out
}
