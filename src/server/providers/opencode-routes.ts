/** Native OpenCode routes, with unpublished request/response schemas absent. */
import { fetchText, sha256Text } from './types.ts'
import type { OpenApiDocument, SpecFetchResult } from './types.ts'

export const ROUTE_ONLY_MARKER = 'x-modelschemas-route-only'
const ROUTE_ACTIVITY = 'x-modelschemas-opencode-activity'
const SOURCE_ROOT =
  'https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/console/app/src/routes/zen/'

interface RouteRow {
  schemaEndpointId: string | null
  activity: string | null
}

export async function openCodeRouteSpec(
  rows: Array<RouteRow>,
  docs: { url: string; text: string },
  go: boolean,
): Promise<SpecFetchResult> {
  const paths: NonNullable<OpenApiDocument['paths']> = {}
  const code = new Map<string, { text: string; hash: string }>()
  for (const row of rows) {
    if (!row.schemaEndpointId || row.activity !== 'chat') continue
    const path = `/${row.schemaEndpointId.replace(/^\//, '')}`
    const file = path.startsWith('/v1/models/')
      ? 'v1/models/[model]'
      : path.slice(1)
    const url = `${SOURCE_ROOT}${go ? 'go/' : ''}${file}.ts`
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
    throw new Error('opencode: docs name no verified chat routes')
  return {
    specs: [{ openapi: '3.1.0', paths }],
    sources: [{ url: docs.url, hash: await sha256Text(docs.text) }],
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
