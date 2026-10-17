/** Native OpenCode routes, with unpublished request/response schemas absent. */
import { fetchText, sha256Text } from './types.ts'
import type { OpenApiDocument, SpecFetchResult } from './types.ts'

export const ROUTE_ONLY_MARKER = 'x-modelschemas-route-only'
const ROUTE_ACTIVITY = 'x-modelschemas-opencode-activity'
const SOURCE_ROOT =
  'https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/console/app/src/routes/zen/'

interface RouteRow {
  schemaEndpointId?: string | null
  activity?: string | null
}

/**
 * Protocol paths the console's inference proxy (`lib/inference-proxy.ts`)
 * maps the `routes/zen/v1` handlers onto, and the handler each one serves.
 */
const PROTOCOL_ROUTES: Record<string, RegExp> = {
  'openai/v1/': /^(?:chat\/completions|responses)$/,
  'anthropic/v1/': /^messages$/,
  'google/v1beta/': /^models\/[^/]+$/,
}

/** Public path → handler file under `routes/zen`. Zen ids are `inference/[protocol/]v1/...`; the source tree is still `v1`. */
function sourceFile(schemaEndpointId: string, go: boolean): string {
  let local = schemaEndpointId.replace(/^\//, '').replace(/^inference\//, '')
  const prefix = Object.keys(PROTOCOL_ROUTES).find((p) => local.startsWith(p))
  if (prefix) {
    const tail = local.slice(prefix.length)
    if (!PROTOCOL_ROUTES[prefix]?.test(tail))
      throw new Error(`opencode: ${schemaEndpointId} is no ${prefix} route`)
    local = `v1/${tail}`
  }
  if (!local.startsWith('v1/'))
    throw new Error(`opencode: ${schemaEndpointId} names no native route`)
  const file = /^v1\/models\/.+/.test(local) ? 'v1/models/[model]' : local
  return `${go ? 'go/' : ''}${file}`
}

export async function openCodeRouteSpec(
  rows: Array<RouteRow>,
  docs: { url: string; text?: string; hash?: string },
  go: boolean,
): Promise<SpecFetchResult> {
  const paths: NonNullable<OpenApiDocument['paths']> = {}
  const code = new Map<string, { text: string; hash: string }>()
  for (const row of rows) {
    if (!row.schemaEndpointId || row.activity !== 'chat') continue
    const path = `/${row.schemaEndpointId.replace(/^\//, '')}`
    const url = `${SOURCE_ROOT}${sourceFile(row.schemaEndpointId, go)}.ts`
    let native = code.get(url)
    if (!native) {
      const text = await fetchText(url, { signal: AbortSignal.timeout(30_000) })
      if (!/export\s+(?:async\s+)?function\s+POST\s*\(/.test(text))
        throw new Error(
          `opencode: native route ${url} publishes no POST handler`,
        )
      native = { text, hash: await sha256Text(text) }
      code.set(url, native)
    }
    paths[path] = {
      post: {
        [ROUTE_ONLY_MARKER]: true,
        [ROUTE_ACTIVITY]: 'chat',
        'x-modelschemas-method-source': { url, hash: native.hash },
        responses: {},
      },
    }
  }
  if (Object.keys(paths).length === 0)
    throw new Error('opencode: catalog names no verified chat routes')
  const hash =
    docs.hash ?? (docs.text !== undefined ? await sha256Text(docs.text) : null)
  if (!hash) throw new Error('opencode: route spec has no catalog source')
  return {
    specs: [{ openapi: '3.1.0', paths }],
    sources: [{ url: docs.url, hash }],
    outputStrategy: 'post-200',
  }
}

export function classifyOpenCodeRoute(
  _path: string,
  operation: Record<string, unknown>,
): 'chat' | null {
  return operation[ROUTE_ONLY_MARKER] === true &&
    operation[ROUTE_ACTIVITY] === 'chat'
    ? 'chat'
    : null
}
