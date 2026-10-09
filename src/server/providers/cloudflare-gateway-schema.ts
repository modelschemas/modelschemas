/** Mechanically bind Cloudflare's per-model inputs to its own universal REST route. */
import type { BundledEndpoint, ModelInfo, SpecSource } from './types.ts'

export const GATEWAY_REST_DOCS =
  'https://raw.githubusercontent.com/cloudflare/cloudflare-docs/production/src/content/docs/ai-gateway/usage/rest-api.mdx'
export interface GatewayRunContract {
  path: string
  source: SpecSource
}

export function parseGatewayRunContract(
  text: string,
  source: SpecSource,
): GatewayRunContract {
  if (
    !/`POST \/ai\/run`\s*\|\s*Envelope with `model`, `input`/.test(text) ||
    !/Model-specific parameters go inside `input`/.test(text)
  )
    throw new Error(
      'cloudflare-ai-gateway: native docs publish no model/input envelope',
    )
  const url = text.match(
    /curl -X POST "(https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/\$[A-Z_]+\/ai\/run)"/,
  )?.[1]
  if (!url)
    throw new Error(
      'cloudflare-ai-gateway: native docs publish no universal POST path',
    )
  return {
    path: url
      .replace('https://api.cloudflare.com/client/v4', '')
      .replace(/\$[A-Z_]+/, '{account_id}'),
    source,
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A wrapped schema's root-relative refs must still address its original root. */
function wrappedInput(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(wrappedInput)
  if (!record(value)) return value
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (key === '$id')
        throw new Error(
          'cloudflare-ai-gateway: scoped input $id cannot be wrapped',
        )
      if (key === '$ref') {
        if (typeof item !== 'string' || !item.startsWith('#'))
          throw new Error(
            'cloudflare-ai-gateway: input schema has an external reference',
          )
        if (item !== '#' && !item.startsWith('#/'))
          throw new Error(
            'cloudflare-ai-gateway: input schema has an unsupported anchor reference',
          )
        return [key, `#/properties/input${item.slice(1)}`]
      }
      return [key, wrappedInput(item)]
    }),
  )
}

/** A native input record containing only its dialect declares no body fields. */
export function hasGatewayInputSchema(value: unknown): boolean {
  return record(value) && Object.keys(value).some((key) => key !== '$schema')
}

export function catalogGatewayEndpoint(
  catalog: unknown,
  info: ModelInfo,
  source: SpecSource,
  contract: GatewayRunContract,
): BundledEndpoint | null {
  if (info.activity == null) return null
  if (record(catalog) && catalog.schema == null) return null
  if (!record(catalog) || !record(catalog.schema))
    throw new Error(
      `cloudflare-ai-gateway: ${info.rawId} has no native schema object`,
    )
  const input = catalog.schema.input
  if (input == null || (record(input) && !hasGatewayInputSchema(input)))
    return null
  if (!record(input))
    throw new Error(
      `cloudflare-ai-gateway: ${info.rawId} input schema is not an object`,
    )
  return {
    publicId: info.rawId,
    path: contract.path,
    activity: info.activity,
    description: info.displayName ?? null,
    source,
    derivation: 'generated',
    input: {
      type: 'object',
      properties: {
        model: { type: 'string', const: info.rawId },
        input: wrappedInput(input),
      },
      // Native docs name the envelope fields but do not publish their required list.
      'x-modelschemas-envelope-source': contract.source,
    },
    // The catalog's intrinsic output does not establish the /ai/run HTTP envelope.
  }
}
