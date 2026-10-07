/**
 * Chat facts for FAL's text endpoints, read from the endpoint's own OpenAPI
 * request schema (models API, `expand=openapi-3.0`) and its listing
 * description. Every FAL endpoint has its own request body, so nothing here
 * is shared across rows. A router that takes a `model` field states no
 * window, output cap, or reasoning config of its own: those stay null.
 */
import { extractEndpointSchemas } from '#/server/ingest/bundle.ts'
import { walkRequestSchema } from './fact-sources.ts'
import { tokenCount } from './model-facts.ts'
import type {
  FactSource,
  ModelFactSources,
  ModelInfo,
  ModelReasoning,
  OpenApiDocument,
} from './types.ts'

export type FalChatFacts = Pick<
  ModelInfo,
  | 'contextWindow'
  | 'maxOutput'
  | 'modalities'
  | 'capabilities'
  | 'reasoning'
  | 'factSources'
>

/** `256K context` in the listing description. The unit and word are required. */
const CONTEXT = /\b(\d+(?:\.\d+)?[KkMm])[ \t]+context\b/g

/** FAL names media inputs `<medium>_url` or `<medium>_urls`. */
const MEDIA_PROPERTY = /^(image|audio|video)_urls?$/

const MAX_OUTPUT_PROPERTIES = ['max_completion_tokens', 'max_tokens']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The node and its `anyOf` members: FAL wraps optional fields as `T | null`. */
function variants(node: unknown): Array<Record<string, unknown>> {
  if (!isRecord(node)) return []
  const anyOf = Array.isArray(node.anyOf) ? node.anyOf.filter(isRecord) : []
  return [node, ...anyOf]
}

function stringEnum(node: unknown): Array<string> | null {
  const found = variants(node).filter((v) => Array.isArray(v.enum))
  const only = found.length === 1 ? found[0]?.enum : null
  return Array.isArray(only) &&
    only.length > 0 &&
    only.every((item): item is string => typeof item === 'string')
    ? only
    : null
}

function integerMaximum(node: unknown): number | null {
  const found = variants(node).filter(
    (v) => v.type === 'integer' && typeof v.maximum === 'number',
  )
  const maximum = found.length === 1 ? found[0]?.maximum : null
  return typeof maximum === 'number' && Number.isInteger(maximum) && maximum > 0
    ? maximum
    : null
}

/** The one context size the description states, or null. */
export function falDescriptionContextWindow(
  description: string | undefined,
): number | null {
  const stated = new Set(
    [...(description ?? '').matchAll(CONTEXT)].map((m) => tokenCount(m[1])),
  )
  const [only] = [...stated]
  return stated.size === 1 && only != null && only > 0 ? only : null
}

/** The models API URL that returns one endpoint with its OpenAPI document. */
export function falEndpointSpecUrl(listingUrl: string, rawId: string): string {
  return `${listingUrl}?endpoint_id=${rawId}&expand=openapi-3.0`
}

export function falChatFacts(
  model: {
    endpoint_id: string
    description?: string
    openapi?: OpenApiDocument
  },
  listingUrl: string,
): FalChatFacts {
  const facts: FalChatFacts = {}
  const sources: ModelFactSources = {}

  const contextWindow = falDescriptionContextWindow(model.description)
  if (contextWindow !== null) {
    facts.contextWindow = contextWindow
    sources.contextWindow = {
      derivation: 'listing',
      sourceUrl: listingUrl,
      path: 'metadata.description',
    }
  }

  const rawId = model.endpoint_id
  // A spec fetched by `endpoint_id` can name its path by the app's internal
  // alias (`/fal-ai/nemotron-…` for `nvidia/nemotron-…`), so take the
  // document's one POST path instead of building it from the id.
  const posts = Object.entries(model.openapi?.paths ?? {})
    .filter(([, operations]) => operations.post !== undefined)
    .map(([path]) => path)
  const [postPath] = posts
  const extracted =
    model.openapi && posts.length === 1 && postPath !== undefined
      ? extractEndpointSchemas(model.openapi, postPath, 'sibling-get')
      : null
  const input = extracted?.input
  const properties = isRecord(input?.properties) ? input.properties : {}
  if (Object.keys(properties).length > 0) {
    const sourceUrl = falEndpointSpecUrl(listingUrl, rawId)
    const source = (path: string): FactSource => ({
      derivation: 'upstream-spec',
      sourceUrl,
      endpointId: rawId,
      path,
    })

    for (const name of MAX_OUTPUT_PROPERTIES) {
      const maximum = integerMaximum(properties[name])
      if (maximum === null) continue
      facts.maxOutput = maximum
      sources.maxOutput = source(`/properties/${name}/maximum`)
      break
    }

    // `thinking` must name `enabled`, or the enum is a shape we do not know.
    const efforts = stringEnum(properties.reasoning_effort)
    const thinking = stringEnum(properties.thinking)
    // The endpoint's own on/off switch. Any other value set is not read.
    const mode = stringEnum(properties.reasoning_mode)
    let reasoning: ModelReasoning | null = null
    if (efforts && thinking?.includes('enabled')) {
      reasoning = {
        mode: 'effort',
        mandatory: !thinking.includes('disabled'),
        efforts,
      }
      facts.reasoning = reasoning
      sources.reasoning = source('/properties/reasoning_effort')
    } else if (
      !efforts &&
      !thinking &&
      [...(mode ?? [])].sort().join() === 'no_think,think'
    ) {
      reasoning = { mode: 'toggle', mandatory: false }
      facts.reasoning = reasoning
      sources.reasoning = source('/properties/reasoning_mode')
    }

    // Text is named by `prompt`, never assumed.
    if ('prompt' in properties) {
      const media = Object.keys(properties)
        .map((name) => MEDIA_PROPERTY.exec(name)?.[1])
        .filter((medium) => medium !== undefined)
      const output = extracted?.output?.properties
      const emitsText =
        isRecord(output) &&
        isRecord(output.output) &&
        output.output.type === 'string'
      facts.modalities = {
        input: ['text', ...new Set(media)],
        output: emitsText ? ['text'] : [],
      }
      sources.modalities = source('/properties')
    }

    // The router's boolean `reasoning` only asks for the trace in the
    // answer. Keep the flag for rows whose reasoning config was read.
    const walk = walkRequestSchema(input, {
      derivation: 'upstream-spec',
      endpointId: rawId,
      sourceUrl,
    })
    const flags = (walk?.flags ?? []).filter(
      (flag) => flag !== 'reasoning' || reasoning !== null,
    )
    facts.capabilities = flags
    if (flags.length > 0) {
      sources.capabilities = Object.fromEntries(
        flags.map((flag) => [
          flag,
          walk?.sources.capabilities?.[flag] ?? source('/properties'),
        ]),
      )
    }
  }

  if (Object.keys(sources).length > 0) facts.factSources = sources
  return facts
}
