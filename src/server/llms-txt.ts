/**
 * The /llms.txt agent guide (PLAN.md task 4.1). Shared module so the /docs
 * page (7.3) and the distributable skill (7.6) render from the same source.
 */
export const llmsTxt = `# modelschemas

Live AI model schema service. Per-endpoint request/response JSON Schemas and
model metadata for monitored providers (OpenAI, Anthropic, Gemini, xAI Grok,
ElevenLabs, OpenRouter, FAL), refreshed automatically: model lists every 15
minutes, full OpenAPI spec syncs daily. Every response is JSON.

## Why use this

- Discover which models exist *right now*, across providers, by activity
  (chat, image, video, audio, embeddings, moderation).
- Fetch a self-contained JSON Schema (refs bundled under $defs) for any
  provider generation endpoint — request (input) and response (output).
- Validate a payload server-side before spending tokens on a provider call.
- Poll /v1/changes (or subscribe via webhooks) to hear about new models and
  API revisions.

## Quickstart (no auth needed for reads)

1. GET /v1 — endpoint index.
2. GET /v1/models?activity=chat — cross-provider catalog of chat models.
3. GET /v1/schemas/anthropic — activities + endpoint ids for Anthropic.
4. GET /v1/schemas/anthropic/chat/{endpointId}?kind=input — the JSON Schema
   for a request body (endpoint ids contain slashes; URL-encode them).
5. POST /v1/validate {"provider","endpointId","payload"} — check a payload.
6. GET /v1/changes?since=<unix epoch> — what changed.

## Hypermedia (HAL, extended)

Every JSON read response carries \`_links\`: HAL link objects extended with
\`method\`, \`contentType\`, and an inline \`example\` (a resolvable URL for
GETs, a request body for POSTs) so you can follow the API without consulting
docs. Templated hrefs (RFC 6570) set \`"templated": true\` and always include
an example. Start at GET /v1 and follow \`_links\`.

## Long-polling

No sleep tool? Add \`?wait=30\` (seconds, cap 60, \`30s\` form accepted) to
GET /v1/changes or GET /v1/status: the request holds until new data lands or
the window expires, then returns whatever is current. One request, one
rate-limit token.

## Caching

Read responses carry ETag (content hash), Last-Modified, Cache-Control with
stale-while-revalidate, X-Fetched-At and X-Stale-At (unix epoch seconds).
Send If-None-Match to get 304s.

## Auth (optional — unlocks higher rate limits + webhooks)

- Agent-auth protocol: discovery at /.well-known/agent-configuration,
  register at POST /api/auth/agent/register, then execute capabilities with
  short-lived JWTs.
- Simple alternative: POST /v1/agents/register-key { "name" } returns an API
  key once; send it as Authorization: Bearer <key>.

## Machine-readable spec

GET /openapi.json — OpenAPI 3.1 for this service; every operation has an
operationId. GET /skill — installable agent skill (SKILL.md) teaching this
full workflow.

## Errors

All errors are JSON: { "error": { "code", "message" } }. Messages include
remedies (e.g. valid provider ids on a 404).
`
