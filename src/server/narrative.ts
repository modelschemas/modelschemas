/**
 * Narrative API root (PLAN.md task 11.2). A JSON-accepting GET / returns
 * what an MCP `initialize` instructions field carries: narrative
 * description, workflow, inline examples, and HAL links. The instructions
 * text IS the llms.txt source, so the three surfaces (root narrative, MCP
 * initialize, llms.txt) cannot drift.
 */
import { serviceIndex } from '#/routes/v1/index.ts'
import { llmsTxt } from '#/server/llms-txt.ts'

/** The MCP initialize `instructions` text — shared with GET / (json). */
export const NARRATIVE_INSTRUCTIONS = llmsTxt

export function narrativeRoot(origin: string): Record<string, unknown> {
  return {
    service: 'modelschemas',
    description:
      'Live AI model schemas: which models exist right now, and what their request/response payloads look like — model lists refresh every 15 minutes, full provider specs daily.',
    instructions: NARRATIVE_INSTRUCTIONS,
    quickstart: [
      `GET ${origin}/v1/models?activity=chat&q=claude — what can I call right now`,
      `GET ${origin}/v1/schemas/anthropic/chat/v1%2Fmessages?kind=input — exact request shape`,
      `POST ${origin}/v1/validate — check a payload before spending tokens`,
      `POST ${origin}/v1/estimate — USD from the stored rate card`,
      `GET ${origin}/v1/changes?limit=20 — what changed since I last looked`,
    ],
    mcp: { endpoint: `${origin}/mcp`, transport: 'streamable-http' },
    _links: serviceIndex._links,
  }
}

/** True for GET/HEAD requests that explicitly prefer JSON over HTML. */
export function wantsJsonRoot(request: Request): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false
  const accept = request.headers.get('accept') ?? ''
  return accept.includes('application/json') && !accept.includes('text/html')
}
