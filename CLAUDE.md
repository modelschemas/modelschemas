# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

A Cloudflare Workers service giving AI agents live access to model schemas:
per-endpoint request/response JSON Schemas and model metadata for 7 monitored
providers (OpenAI, Anthropic, Gemini, xAI Grok, ElevenLabs, OpenRouter, FAL),
with react-query-style server-side caching (D1 source of truth, KV hot cache,
stale-while-revalidate) and cron-driven auto-refresh. Design ported from
TanStack AI PR #622 (`@tanstack/ai-schemas`), minus codegen — schemas are
extracted/bundled at runtime and served over HTTP/MCP.

**`PLAN.md` is the build log** — every task, settled architecture decision,
and gotcha note. All phases are complete and the service is live at
https://modelschemas.openstory.workers.dev (npm publish, 8.4, still pends an
npm scope decision). Don't relitigate PLAN.md's
"Architecture decisions" section.

## Commands

Bun is the package manager; the repo is a bun workspace (`packages/*`).

```bash
bun install              # install + link workspace packages
bun run dev              # dev server on http://localhost:3100 (NOT --bun: bun's ws shim hangs vite)
bun run test             # vitest, unit + workers projects (NOT --bun: cloudflare pool needs node)
bun run test src/path/to/file.test.ts       # single test file
bun --bun run lint       # eslint (no-explicit-any + no-unsafe-* are errors)
bun run typecheck        # tsc --noEmit (includes packages/*)
bun --bun run format     # prettier --write + eslint --fix
bun --bun run check      # prettier --check
bun --bun run build      # production build (emits dist/server/wrangler.json)
bun run deploy           # build + wrangler deploy
```

Database (drizzle-kit generates; wrangler applies):

```bash
bun run db:generate          # generate migrations from src/db/schema.ts
bun run db:migrate           # apply to wrangler's LOCAL D1
bun run db:migrate:remote    # apply to remote D1
bun run seed                 # seed the 7 providers (--remote for prod)
```

Generated artifacts (committed; CI fails on drift):

```bash
bun run openapi:emit         # src/server/openapi.ts → openapi.json
bun run generate:client      # → packages/client/src/generated (hey-api 0.97.2, pinned)
bun run check:client         # regenerate + git diff --exit-code (CI step)
bun scripts/emit-skill.ts    # src/server/skill.ts → skill/modelschemas/SKILL.md
```

`openapi.json` and `SKILL.md` are prettier-ignored (byte-stable emitted
artifacts). Lefthook pre-commit runs prettier/eslint/typecheck — never
`--no-verify`. The cloudflare vite plugin is skipped under vitest;
Workers-binding tests (`*.worker.test.ts`) run in workerd via
`@cloudflare/vitest-pool-workers` (config: `vitest.workers.config.ts`,
migrations auto-applied via TEST_MIGRATIONS).

Local verification flows: `bun scripts/agent-roundtrip.ts` (agent-auth
register→execute), `bun scripts/client-smoke.ts` (typed client),
`bun packages/cli <cmd>` (CLI). Admin sync:
`curl -X POST localhost:3100/v1/admin/sync/openrouter -H "X-Admin-Key: $ADMIN_KEY"`.

## Architecture

TanStack Start (React 19, SSR) on Cloudflare Workers via the Cloudflare vite
plugin + `wrangler.jsonc`. Tailwind v4. Worker entry is `src/worker.ts`:
rate-limits `/v1/*`, delegates fetch to the Start handler, and runs the two
crons (15-min models poll + webhook drain; daily 05:00 UTC spec sync).

Request path: route files in `src/routes/` (server handlers via
`server.handlers`) → service functions in `src/server/` → drizzle/D1 +
KV. Bindings come from `import { env, waitUntil } from 'cloudflare:workers'` —
typed by the committed, wrangler-generated `worker-configuration.d.ts`
(`bun run types` regenerates it; rerun after changing wrangler.jsonc or
.env.local since secret names are typed into Env). Workers runtime types are
GLOBAL (KVNamespace, D1Database, …) — do not import from
@cloudflare/workers-types (removed; its types conflict with the generated
ones).

- **Ingest** (`src/server/providers/` + `src/server/ingest/`): per-provider
  `ProviderConfig` (fetchSpec/listModels/classify) → `bundle.ts` extracts
  request/response schemas and inlines `$ref` closures under `$defs` →
  `sync.ts` content-hash-diffs into `schema_versions` + `changes`, warms KV;
  `poll-models.ts` diffs model lists. Keyed providers skip cleanly when the
  secret is absent.
- **API** (`src/routes/v1/`): catalog, schema reads (SWR via
  `src/server/cache.ts`, ETag/304 via `http-cache.ts`), `POST /v1/validate`
  (@cfworker/json-schema), cursor-paginated `/v1/changes`, subscriptions.
  Errors are always `{ error: { code, message } }` with remediation hints.
- **MCP** (`src/server/mcp.ts`, route `/mcp`): stateless streamable-HTTP
  JSON-RPC wrapping the same service functions.
- **Auth** (`src/lib/auth.ts` factory → lazy runtime instance in
  `src/server/auth.ts`; betterAuth CANNOT construct at module scope in
  workerd): better-auth + agent-auth (capabilities derived from
  `src/server/openapi.ts`, admin ops excluded), api-key fallback, bearer.
  `requireAgent` (`src/server/require-agent.ts`) guards native routes; agent
  JWT jtis are single-use — mint per request. Rate limiting
  (`src/server/rate-limit.ts`): KV fixed-window, 60/h anon-IP, 5k/h
  per verified credential.
- **Webhooks** (`src/server/webhooks.ts`): checkpointed fan-out of `changes`
  to subscriptions, HMAC-SHA256-signed delivery, exponential backoff,
  auto-pause after 8 failures; drained by the 15-min cron. Destination URLs
  are SSRF-guarded (public https only, no redirects).
- **DB** (`src/db/schema.ts`): better-auth tables + providers/models/
  endpoints/schema_versions/changes + cache_meta/subscriptions/
  webhook_deliveries. Epoch-second integers for our tables; ids are slugs
  (`provider/path` for endpoints, `provider-rawid-slug` for models).
- **Workspace packages**: `packages/client` (`@modelschemas/client`,
  generated + hand-written auth entry), `packages/cli` (`modelschemas` bin:
  login/whoami/models/schema/validate/changes/subscribe).
- **Path aliases**: `#/*` and `@/*` → `./src/*`; `.ts` import extensions
  allowed. `src/routeTree.gen.ts` is generated by the DEV SERVER (the pinned
  `tsr` CLI emits an old format) — never edit by hand; boot `bun run dev`
  after adding routes, then typecheck.
- **Env**: `.env.local` holds `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`
  (http://localhost:3100 — JWT audiences are origin-bound), `ADMIN_KEY`,
  optional provider keys. Prod: `wrangler secret put`. README has the full
  production-setup + runbook.

API map: `GET /v1` (index) · `/v1/status` · `/v1/providers[/{p}/models]` ·
`/v1/models[?activity,provider,capability,q]` · `/v1/models/{p}/{id}` ·
`/v1/schemas/{p}[/{activity}[/{endpointId}?kind,version]]` ·
`POST /v1/validate` · `/v1/changes` · `POST /v1/agents/register-key` ·
`/v1/agents/me` · `/v1/subscriptions` · `POST /v1/admin/sync/{p}` ·
`/openapi.json` · `/llms.txt` · `/skill` · `/docs` · `/mcp` ·
`/.well-known/agent-configuration`.
