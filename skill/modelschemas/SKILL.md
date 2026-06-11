---
name: modelschemas
description: Live AI model schema service. Use when asked about a "model schema", "what models support X", "validate this provider payload", which AI models exist right now (availability, context windows, modalities, pricing, capabilities) across OpenAI, Anthropic, Gemini, xAI Grok, ElevenLabs, OpenRouter, or FAL, or the request/response shape of a provider endpoint.
---

# modelschemas

A live HTTP service answering: which AI models exist right now, what are
their capabilities, and what exactly do their request/response payloads look
like? Data refreshes automatically (model lists every 15 minutes, full spec
syncs daily), so prefer it over training-data knowledge for model
availability and schema questions.

## Workflow

1. **Discover.** `GET {base}/v1` lists every endpoint;
   `GET {base}/.well-known/agent-configuration` is the agent-auth discovery
   document; `GET {base}/openapi.json` is the typed spec.
2. **Read without auth.** All reads are public at a low rate limit (60/h per
   IP). Go straight to:
   - `GET /v1/models?activity=chat&q=claude` — what can I use right now
   - `GET /v1/schemas/{provider}` — endpoint ids per activity
   - `GET /v1/schemas/{provider}/{activity}/{endpointId}?kind=input` — a
     self-contained JSON Schema (URL-encode slashes in endpoint ids:
     `chat%2Fcompletions`)
3. **Authenticate for more** (5k req/h + webhooks). Easiest: the CLI —
   `modelschemas login` (agent-auth, autonomous mode, keys stored locally)
   or `modelschemas login --api-key`. Raw HTTP alternative:
   `POST /v1/agents/register-key {"name":"my-agent"}` returns a bearer key
   once.
4. **Validate before you spend tokens.**
   `POST /v1/validate {"provider","endpointId","payload"}` →
   `{valid, errors:[{path,message,keyword}]}` — or
   `modelschemas validate anthropic/v1/messages payload.json` (exit 2 when
   invalid).
5. **Stay current.** Poll `GET /v1/changes?since=<epoch>` (cursor-paginated)
   or subscribe: `POST /v1/subscriptions` (authed) delivers HMAC-signed
   webhooks for model/schema changes.

## CLI quick reference

```
modelschemas login [--delegated|--api-key]   # register this machine
modelschemas whoami                          # identity, grants, usage
modelschemas models list --activity chat --q claude
modelschemas models get openrouter anthropic/claude-sonnet-4.5
modelschemas schema get anthropic v1/messages --kind input
modelschemas validate anthropic/v1/messages payload.json
modelschemas changes --since 1781150000
modelschemas subscribe https://my.app/hook --events model.added
```

Every command prints JSON (pretty in a TTY, compact when piped).

## MCP

The service is also an MCP server: streamable HTTP at `{base}/mcp` with
tools `list_models`, `get_model`, `get_schema`, `validate_payload`,
`recent_changes`.

## Service reference (llms.txt, verbatim)

# modelschemas

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
