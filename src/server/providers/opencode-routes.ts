/** Native OpenCode routes, with unpublished request/response schemas absent. */
import { markdownSection, markdownTableRows } from './model-facts.ts'
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

/** Paths the page's `## Endpoints` table lists. Throws when it lists none. */
export function documentedRoutes(text: string, url: string): Array<string> {
  const routes: Array<string> = []
  for (const cells of markdownTableRows(markdownSection(text, 'Endpoints'))) {
    for (const cell of cells) {
      const code = /^`([^`]+)`$/.exec(cell)?.[1] ?? ''
      const path = code.startsWith(ORIGIN) ? code.slice(ORIGIN.length) : code
      if (path.startsWith('/inference/')) routes.push(path)
    }
  }
  if (routes.length === 0)
    throw new Error(`opencode: ${url} documents no endpoint paths`)
  return routes
}

/**
 * A documented path as a matcher for a stored path. A `<placeholder>` matches
 * one path segment. Go ids stay `v1/<tail>` (opencode-catalog.ts), so Go
 * drops the `/inference/go/<protocol>` prefix the docs put before `/v1/`.
 */
function routePattern(documented: string, go: boolean): RegExp {
  const local = go
    ? documented.replace(/^\/inference\/go\/[^/]+(?=\/v1\/)/, '')
    : documented
  const escaped = local.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${escaped.replace(/<[^>]+>/g, '[^/:]+')}$`)
}

export async function openCodeRouteSpec(
  rows: Array<RouteRow>,
  docs: { url: string; text?: string; hash?: string },
  go: boolean,
): Promise<SpecFetchResult> {
  const routes = rows.flatMap((row) =>
    row.schemaEndpointId && row.activity === 'chat'
      ? [`/${row.schemaEndpointId.replace(/^\//, '')}`]
      : [],
  )
  if (routes.length === 0)
    throw new Error('opencode: catalog names no verified chat routes')
  const url = go ? OPENCODE_GO_ROUTE_DOCS_URL : OPENCODE_ROUTE_DOCS_URL
  const text = await fetchText(url, { signal: AbortSignal.timeout(30_000) })
  const documented = documentedRoutes(text, url).map((path) =>
    routePattern(path, go),
  )
  const method = { url, hash: await sha256Text(text) }
  const paths: NonNullable<OpenApiDocument['paths']> = {}
  for (const path of routes) {
    if (!documented.some((pattern) => pattern.test(path)))
      throw new Error(`opencode: ${url} documents no ${path} route`)
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
