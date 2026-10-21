/** Native OpenCode routes, with unpublished request/response schemas absent. */
import { fetchText, sha256Text } from './types.ts'
import type { OpenApiDocument, SpecFetchResult } from './types.ts'

export const ROUTE_ONLY_MARKER = 'x-modelschemas-route-only'
const ROUTE_ACTIVITY = 'x-modelschemas-opencode-activity'
const DOCS_ROOT =
  'https://raw.githubusercontent.com/anomalyco/opencode/dev/services/www/src/docs/content/console/'
/** Source of https://opencode.ai/v2/docs/console/api/inference/: Zen's Endpoints table. */
export const OPENCODE_ROUTE_DOCS_URL = `${DOCS_ROOT}api/inference.mdx`
/** Source of https://opencode.ai/v2/docs/console/go/: Go's per-model Endpoints table. */
export const OPENCODE_GO_ROUTE_DOCS_URL = `${DOCS_ROOT}go.mdx`
const ORIGIN = 'https://opencode.ai'

interface RouteRow {
  schemaEndpointId?: string | null
  activity?: string | null
}

/** Allowed tails for each public protocol prefix. */
const PROTOCOL_ROUTES: Record<string, RegExp> = {
  'openai/v1/': /^(?:chat\/completions|responses)$/,
  'anthropic/v1/': /^messages$/,
  'google/v1beta/': /^models\/[^/]+$/,
}

/** Paths the page's `## Endpoints` table lists. Throws when it lists none. */
export function documentedRoutes(text: string, url: string): Set<string> {
  const section = /^## Endpoints[ \t]*$([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(
    text,
  )?.[1]
  const routes = new Set<string>()
  for (const line of section?.split('\n') ?? []) {
    if (!line.trimStart().startsWith('|')) continue
    for (const [, cell = ''] of line.matchAll(/`([^`]+)`/g)) {
      const path = cell.startsWith(ORIGIN) ? cell.slice(ORIGIN.length) : cell
      if (path.startsWith('/inference/')) routes.add(path)
    }
  }
  if (routes.size === 0)
    throw new Error(`opencode: ${url} documents no endpoint paths`)
  return routes
}

/**
 * Docs path for a stored id. Zen ids are the docs path. Go ids stay
 * `v1/<tail>` (opencode-catalog.ts); the docs serve each tail under
 * `/inference/go/<protocol>/`.
 */
function docsPath(schemaEndpointId: string, go: boolean): string {
  const id = schemaEndpointId.replace(/^\//, '')
  if (!go) return `/${id}`
  const tail = id.startsWith('v1/') ? id.slice('v1/'.length) : ''
  const prefix = Object.keys(PROTOCOL_ROUTES).find((p) =>
    PROTOCOL_ROUTES[p]?.test(tail),
  )
  if (!prefix)
    throw new Error(`opencode-go: ${schemaEndpointId} names no native route`)
  return `/inference/go/${prefix}${tail}`
}

function isDocumented(path: string, routes: Set<string>): boolean {
  // inference.mdx writes the Gemini row as `.../models/<model>:generateContent`.
  return (
    routes.has(path) ||
    routes.has(path.replace(/\/models\/[^/:]+/, '/models/<model>'))
  )
}

export async function openCodeRouteSpec(
  rows: Array<RouteRow>,
  docs: { url: string; text?: string; hash?: string },
  go: boolean,
): Promise<SpecFetchResult> {
  const routes = new Map<string, string>()
  for (const row of rows) {
    if (!row.schemaEndpointId || row.activity !== 'chat') continue
    const path = `/${row.schemaEndpointId.replace(/^\//, '')}`
    routes.set(path, docsPath(row.schemaEndpointId, go))
  }
  if (routes.size === 0)
    throw new Error('opencode: catalog names no verified chat routes')
  const url = go ? OPENCODE_GO_ROUTE_DOCS_URL : OPENCODE_ROUTE_DOCS_URL
  const text = await fetchText(url, { signal: AbortSignal.timeout(30_000) })
  const documented = documentedRoutes(text, url)
  const method = { url, hash: await sha256Text(text) }
  const paths: NonNullable<OpenApiDocument['paths']> = {}
  for (const [path, docPath] of routes) {
    if (!isDocumented(docPath, documented))
      throw new Error(`opencode: ${url} documents no ${docPath} route`)
    paths[path] = {
      post: {
        [ROUTE_ONLY_MARKER]: true,
        [ROUTE_ACTIVITY]: 'chat',
        'x-modelschemas-method-source': method,
        responses: {},
      },
    }
  }
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
