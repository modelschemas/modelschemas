/**
 * Markdown content negotiation (PLAN.md task 10.5). Agents that send
 * `Accept: text/markdown` on HTML pages get markdown instead of an SSR
 * page: /docs serves the llms.txt source verbatim, / serves a landing
 * summary. Browsers (no text/markdown in Accept) keep HTML.
 */
import { llmsTxt } from '#/server/llms-txt.ts'

export function wantsMarkdown(request: Request): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false
  const accept = request.headers.get('accept') ?? ''
  return accept.includes('text/markdown')
}

function landingMd(origin: string): string {
  return `# modelschemas

Live AI model schemas: which models exist right now, and what their
request/response payloads look like. Model lists refresh every 15 minutes,
full provider specs daily.

## Quickstart

\`\`\`
GET ${origin}/v1/models?activity=chat&q=claude     # what can I call right now
GET ${origin}/v1/schemas/{provider}                # endpoint ids per activity
POST ${origin}/v1/validate                         # check a payload before spending tokens
POST ${origin}/v1/estimate                         # USD from the stored rate card
\`\`\`

No signup for reads (60 req/h per IP; 5,000/h with a key — see ${origin}/auth.md).

## Surfaces

- ${origin}/llms.txt — full agent guide (also served at /docs with this header)
- ${origin}/openapi.json — typed spec, operationIds on every operation
- ${origin}/mcp — MCP server (streamable HTTP): list_models, get_model, get_schema, validate_payload, estimate_cost, recent_changes
- ${origin}/skill — installable agent skill (SKILL.md)
- ${origin}/.well-known/api-catalog — RFC 9727 linkset
- ${origin}/.well-known/agent-configuration — agent-auth discovery
`
}

/** Markdown body for an HTML page path, or null when the path has none. */
export function markdownForPath(
  pathname: string,
  origin: string,
): string | null {
  switch (pathname) {
    case '/':
      return landingMd(origin)
    case '/docs':
      return llmsTxt
    default:
      return null
  }
}

export function markdownResponse(body: string): Response {
  return new Response(body, {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      Vary: 'Accept',
    },
  })
}
