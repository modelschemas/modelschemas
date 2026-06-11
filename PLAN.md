# modelschemas — Live AI Model Schema Service

A Cloudflare Workers service that gives agents live, validated access to AI model schemas
(request/response JSON Schemas per provider endpoint, plus model metadata), with
react-query-style server-side caching: persistent, stale-while-revalidate, auto-refreshed
when providers ship new models or API revisions.

Borrows directly from TanStack AI PR #622 (`@tanstack/ai-schemas`):

- **Provider registry pattern** — a `ProviderConfig` per provider (`fetch` → `load` →
  activity-categorised merged specs). Providers: OpenAI, Anthropic, Gemini, xAI Grok,
  ElevenLabs, OpenRouter, FAL.
- **Activity grouping** — `chat | image | video | audio | embeddings | moderation`;
  platform/admin endpoints classify to `null` and are dropped.
- **Endpoint-id-keyed schema maps** with self-contained JSON Schemas (`$ref` closures
  bundled under `$defs`).
- **Spec-source tricks** — e.g. Anthropic's spec URL resolved from the Stainless
  `.stats.yml`; FAL's `expand=openapi-3.0` param; Gemini Discovery→OpenAPI conversion.

Key difference from the PR: no codegen, no Zod, no npm package. We extract and bundle
JSON Schemas at runtime (pure JSON manipulation — portable to Workers) and serve them
over HTTP. Zod codegen stays in the npm package world; this service is the live API.

---

## Loop protocol

This plan is executed by an autonomous loop. Each iteration:

1. Read this file. Find the first unchecked `- [ ]` task, top to bottom.
2. Implement exactly that task. Stay inside its scope; if you discover necessary
   side-work, add it as a new task in the right phase instead of doing it now.
3. Verify against the task's acceptance criteria. Every task that adds or changes
   behaviour must ship with tests covering it — write them as part of the task, not
   later. Run `bun run test` (plain `bun run`, not `--bun` — bun's ws shim can't
   start the cloudflare vitest pool), `bun --bun run lint`, and `bun run typecheck`;
   all must be green (lefthook enforces lint/format/typecheck on commit — never
   commit with `--no-verify`). For route/API tasks, exercise the endpoint against
   `bun --bun run dev` (vite cloudflare plugin provides local D1/KV bindings —
   note the plugin is skipped under vitest; Workers-runtime tests need
   `@cloudflare/vitest-pool-workers`, see task 0.3).
4. Check the task off (`- [x]`), append a one-line note under it if anything
   non-obvious happened, and commit with a conventional message
   (`feat(api): ...`, `chore(db): ...`).
5. **Phase boundary:** when the task just completed is the last task of its phase,
   run the full test suite and lint one more time — everything green is a hard gate
   before starting the next phase. Make a phase-closing commit
   (`chore: complete phase N`) even if the last task was already committed, and
   confirm CI (task 0.0) passes on that commit. Do not begin the next phase with a
   dirty tree, failing tests, or red CI.
6. If blocked (missing secret, upstream outage, ambiguous requirement), check the task
   off as `- [x] ~BLOCKED:` with the reason, move on to the next task, and surface the
   blocker in the iteration summary.
7. Stop the loop when every task is checked.

Rules:

- No task is done without tests: new behaviour gets new tests, and the whole suite
  passes before the task is checked off.
- Never edit `src/routeTree.gen.ts` by hand.
- All times stored as unix epoch integers; all ids lowercase kebab/slug.
- Every API response is JSON (errors included: `{ error: { code, message } }`).
- No secrets in code. Local: `.env.local` / `.dev.vars`. Prod: `wrangler secret put`.

---

## Architecture decisions (settled — do not relitigate in the loop)

- **D1 is the source of truth**, not KV. We need relational queries (models by
  provider/activity/capability), versioned schema history, diffs, auth tables, and
  webhook subscriptions — that's SQL. **KV is the hot cache** in front of D1 for
  schema blobs (read-heavy, immutable-per-version), keyed by content hash.
- **Two-tier refresh loop** (Cloudflare Cron Triggers):
  - _Fast tier, every 15 min_: poll each provider's cheap model-list endpoint
    (`/v1/models` etc.). New/removed model → update D1, record a change event,
    fire webhooks. This is what catches "new model just dropped".
  - _Slow tier, daily 05:00 UTC_: full OpenAPI spec sync per provider (port of the
    PR #622 fetch+merge+bundle pipeline, minus codegen). Content-hash each bundled
    endpoint schema; changed hash → new schema version row + change event.
- **SWR semantics** (the "server-side react query"): every cached entity carries
  `fetchedAt` + `staleTime`. Reads always serve immediately; if stale, a background
  revalidation runs via `ctx.waitUntil`. Cron is the backstop, SWR is the accelerator.
  Responses expose `ETag`, `Last-Modified`, and `X-Stale-At` so agents can build their
  own cache layers on top.
- **Auth**: Better Auth on D1 (drizzle adapter) with the **agent-auth plugin**
  (`@better-auth/agent-auth`) as the primary flow — the standard agent protocol:
  discovery at `/.well-known/agent-configuration`, `POST /agent/register`, capability
  grants, short-lived signed JWTs (replay-protected, audience-bound) verified in our
  routes via `verifyAgentRequest`. Capabilities are derived from our own
  `openapi.json` with `createFromOpenAPI` where possible, hand-declared otherwise.
  The **api-key plugin** stays as a low-friction alternative for simple bearer access.
  Anonymous read access allowed at a low rate limit; authenticated agents get higher
  limits + webhooks. Reads stay public — auth gates rates, subscriptions, and any
  future write surface, not schema access.
- **Validation**: `@cfworker/json-schema` (built for Workers; ajv's codegen trips CSP/
  eval restrictions).
- **Worker entry**: `wrangler.jsonc` currently points at
  `@tanstack/react-start/server-entry`. Replace with a thin `src/worker.ts` that
  re-exports the Start fetch handler and adds `scheduled` (cron) — and later `queue`
  if we adopt Queues. Webhook delivery starts with `waitUntil` + a retry table drained
  by cron (no paid-plan Queues dependency).

---

## Phase 0 — Platform foundation

- [x] **0.0 CI pipeline.** GitHub Actions workflow (`.github/workflows/ci.yml`)
      running on push to `main` and on pull requests: `oven-sh/setup-bun`,
      `bun install --frozen-lockfile`, `bun --bun run check`, `bun --bun run lint`,
      `bun run typecheck`, `bun --bun run test`, `bun --bun run build`. This is the
      gate the loop protocol's
      phase-boundary step checks against. _Accepts:_ workflow file is valid (passes
      `actionlint` or a dry-run push) and the run is green on the commit that adds it.
  - Note: actionlint not installable in the sandbox; validated via YAML parse + all five
    commands green locally, then confirmed green on GitHub Actions (run 27326004002 on
    commit 320c2b0, the phase 0 closing commit). checkout bumped v4→v5 (node20
    deprecation). Standing permission from Tom to push origin/main each iteration.
- [x] **0.1 Move the database to D1.** Add a `d1_databases` binding (`DB`) to
      `wrangler.jsonc`; switch `src/db/index.ts` to `drizzle-orm/d1` reading the binding
      from the Cloudflare env (expose a `getDb(env)` helper — Workers have no module-scope
      env); update `drizzle.config.ts` to the `d1-http` driver for remote, keep local
      migrations working against wrangler's local D1 (`bun run db:generate` +
      `wrangler d1 migrations apply DB --local`). Remove `better-sqlite3` and the demo
      `todos` table. _Accepts:_ dev server boots, a trivial query against D1 works locally.
  - Note: dev server only boots under `bun run dev` (node runtime) — `bun --bun run dev`
    hangs before vite's ready banner (pre-existing, ws-related). Vite binds IPv6-only
    (`http://[::1]:3000`). `db:migrate` script now applies migrations to local D1 via
    wrangler; `db:migrate:remote` added. `@cloudflare/workers-types` added (type-only,
    drizzle optional peer).
- [x] **0.2 Custom worker entry with cron support.** Create `src/worker.ts` exporting
      `{ fetch }` from the TanStack Start server entry plus a `scheduled(controller, env, ctx)`
      handler that dispatches on `controller.cron`. Point `wrangler.jsonc` `main` at it and
      declare two crons: `*/15 * * * *` (models poll) and `0 5 * * *` (spec sync).
      _Accepts:_ `wrangler dev --test-scheduled` + `curl /__scheduled?cron=*/15+*+*+*+*`
      hits the handler; normal SSR routes still render.
  - Note: on wrangler 4.99 the test endpoint is `/cdn-cgi/handler/scheduled?cron=…`
    (`/__scheduled` 404s); verified against the built worker
    (`wrangler dev --test-scheduled -c dist/server/wrangler.json`) and under vite dev —
    both crons dispatch, SSR home renders in both. Entry-module named exports must be
    handlers only (workerd rejects exported constants), so cron strings stay module-local.
- [x] **0.3 KV namespace + helpers.** Add `kv_namespaces` binding (`SCHEMA_CACHE`).
      Write `src/server/kv.ts` with typed get/put wrapping JSON + content-hash keys.
      The cloudflare vite plugin is incompatible with vitest (it is skipped under
      `VITEST` in `vite.config.ts`), so set up `@cloudflare/vitest-pool-workers`
      (or a miniflare test harness) here for tests that need real KV/D1 bindings.
      _Accepts:_ round-trip test passes under `bun run test` with a real KV binding.
  - Note: pool-workers 0.16 (vitest 4) replaced `defineWorkersConfig` with a
    `cloudflareTest()` vite plugin — config split into vitest.config.ts +
    unit/workers project files (`*.worker.test.ts` runs in workerd). Tests MUST run
    via plain `bun run test`: under `--bun`, bun's ws shim can't start the pool
    runner (hangs after "Timeout starting cloudflare-pool runner"); ci.yml,
    CLAUDE.md, and the loop protocol updated accordingly. Miniflare bindings are
    declared inline (not via wrangler.jsonc configPath) so the pool doesn't try to
    load the TanStack Start worker entry.
- [x] **0.4 Better Auth on D1.** Wire `src/lib/auth.ts` to the drizzle adapter over D1,
      add the `agent-auth` (`@better-auth/agent-auth`), `api-key`, and `bearer` plugins,
      generate auth tables into `src/db/schema.ts` via `bunx --bun @better-auth/cli generate`
      (agent-auth adds `agent`, `host`, `grant`, `approval`), migrate. Keep email/password
      enabled (it backs delegated-mode approvals and the dashboard later). Minimal
      `agentAuth({...})` config for now — providerName/description, `modes:
['autonomous', 'delegated']`, empty capabilities (filled in Phase 5). _Accepts:_
      sign-up + session retrieval works through the existing `/api/auth/$` catch-all
      locally; auth tables present in local D1.
  - Note: better-auth 1.6 moved `apiKey` to `@better-auth/api-key` (added as a dep);
    the option is `providerDescription`, not `description`. Auth is a `createAuth(db)`
    factory in `src/lib/auth.ts` (CLI-loadable via `scripts/better-auth-config.ts`);
    the runtime instance in `src/server/auth.ts` builds from `cloudflare:workers` env
    and passes `tanstackStartCookies()` via `extraPlugins` — that plugin can't be in
    the factory (vite-only `#tanstack-router-entry` imports break the workers test
    pool). Worker tests apply drizzle migrations via the pool's
    TEST_MIGRATIONS/applyD1Migrations pattern. Curl-verified sign-up + get-session
    (needs an `Origin` header, else 403 MISSING_OR_NULL_ORIGIN).

## Phase 1 — Data model

- [x] **1.1 Core tables** in `src/db/schema.ts` (drizzle, sqlite dialect):
  - `providers` — id, displayName, specSourceUrl, modelsEndpoint, authEnvVar,
    lastPolledAt, lastSyncedAt, status.
  - `models` — id (slug), providerId, rawId, activity, displayName, contextWindow,
    maxOutput, modalities (json), pricing (json), capabilities (json), firstSeenAt,
    lastSeenAt, deprecatedAt nullable.
  - `endpoints` — id, providerId, activity, method, path, description.
  - `schema_versions` — id, endpointId, kind (`input`|`output`), contentHash,
    schema (json text, $defs-bundled), specRevision, createdAt, supersededAt nullable.
  - `changes` — id, type (`model.added`|`model.removed`|`model.updated`|
    `schema.added`|`schema.updated`|`endpoint.added`|`endpoint.removed`),
    providerId, subjectId, summary, payload (json diff), createdAt. This is the
    public changelog feed.
    _Accepts:_ migration generated and applied locally; drizzle types compile.
  - Note: migration drizzle/0001_sweet_zeigeist.sql; `activities`/`changeTypes` exported
    as const arrays (drizzle text enums are type-level only). Worker tests cover insert +
    relational query across all five tables and FK enforcement.
- [x] **1.2 Cache + delivery tables:**
  - `cache_meta` — key, fetchedAt, staleTime, lastError, refreshing flag.
  - `subscriptions` — id, agentId (auth user), url, secret, events (json array),
    providerFilter nullable, active, createdAt.
  - `webhook_deliveries` — id, subscriptionId, changeId, attempt, nextAttemptAt,
    status (`pending`|`ok`|`failed`), lastResponseCode.
    _Accepts:_ migration applies; FK relations defined.
  - Note: migration drizzle/0002_violet_lionheart.sql; deliveries indexed on
    (status, nextAttemptAt) for the cron drain. Worker tests cover cache_meta
    round-trip, subscription→user/delivery→change relations, and FK enforcement.
- [x] **1.3 Seed script.** `scripts/seed.ts` inserting the 7 providers with their spec
      source config (port the constants/URLs from PR #622's `scripts/providers/*`:
      Anthropic `.stats.yml` resolution, FAL `expand=openapi-3.0` note, Gemini discovery
      URL, etc.). Runnable via `bun run seed` against local D1. _Accepts:_ `providers`
      table populated locally.
  - Note: seed data lives in `src/db/seed-providers.ts` (typed `$inferInsert`, unit
    tested, reusable by the Phase 2 registry); `scripts/seed.ts` upserts via
    `wrangler d1 execute --file` (idempotent, preserves runtime columns; `--remote`
    flag for prod). URLs/env-vars ported from PR #622 @ 276e808.

## Phase 2 — Ingestion pipeline (the refresh loop)

- [x] **2.1 Provider registry.** `src/server/providers/types.ts` +
      `src/server/providers/{openai,anthropic,gemini,grok,elevenlabs,openrouter,fal}.ts`.
      Port PR #622's `ProviderConfig` shape, adapted to Workers: `fetchSpec(env)` returns
      parsed spec objects (no filesystem), `listModels(env)` hits the provider's models
      endpoint, `classify(path, op)` → `Activity | null`. Providers needing keys are
      skipped with a recorded warning when the secret is absent. _Accepts:_ unit tests
      for `classify` per provider using small spec fixtures.
  - Note: listModels also normalises to the ModelInfo shape (providers own their API
    mapping; 2.4 just diffs). FAL activity rides on a fetch-time per-operation marker
    (category-derived; non-taxonomy targets like 3d/json classify to null for now);
    OpenRouter's video synthesis + embeddings lift ported as exported, unit-tested
    helpers; Anthropic's resolved spec URL doubles as specRevision. `yaml` dep added
    for OpenAI/Anthropic YAML specs.
- [ ] **2.2 Schema extraction + bundling.** `src/server/ingest/bundle.ts`: given a
      merged OpenAPI spec and an endpoint, extract the input schema (request body —
      handle `application/json` and `multipart/form-data`, per the PR's multipart fix)
      and output schema (`post-200` strategy, plus FAL's `sibling-get`), then inline the
      `$ref` closure under `$defs` so every schema is self-contained. Stable
      stringify → SHA-256 content hash. _Accepts:_ unit tests with fixture specs prove
      self-containment (no dangling `$ref`s — port the PR's dedup-rename lesson as a test).
- [ ] **2.3 Sync engine.** `src/server/ingest/sync.ts`: per provider —
      fetch spec → classify endpoints → bundle schemas → diff content hashes against
      `schema_versions` → insert new versions, mark superseded, upsert `endpoints`,
      write `changes` rows, warm KV with new blobs. Idempotent; per-provider try/catch so
      one provider's outage doesn't sink the run; record outcome on `providers`.
      _Accepts:_ integration test with a fixture spec: first run inserts, second run
      no-ops, mutated fixture produces exactly one `schema.updated` change.
- [ ] **2.4 Model poller.** `src/server/ingest/poll-models.ts`: per provider, call
      `listModels`, normalise to the `models` shape, diff against D1 → `model.added` /
      `model.removed` / `model.updated` changes, bump `lastSeenAt`. _Accepts:_ fixture
      test covering add/remove/no-change.
- [ ] **2.5 Wire crons.** `scheduled` dispatch: 15-min cron → `pollAllModels(env, ctx)`,
      daily cron → `syncAllSchemas(env, ctx)`. Stagger providers with `ctx.waitUntil` and
      keep each provider's work sequential to respect subrequest limits. _Accepts:_
      `--test-scheduled` run against live providers (no key required: OpenRouter) writes
      real rows locally.
- [ ] **2.6 Manual trigger + status.** `POST /v1/admin/sync/{provider}` (admin-key
      gated) and `GET /v1/status` (public: per-provider lastPolledAt/lastSyncedAt/counts).
      _Accepts:_ curl both locally.

## Phase 3 — SWR cache layer ("server-side react query")

- [ ] **3.1 `src/server/cache.ts`** — `swr(env, ctx, key, fetcher, { staleTime, hardTtl })`:
      KV hit + fresh → return; KV hit + stale → return AND `ctx.waitUntil(revalidate)`
      guarded by the `cache_meta.refreshing` flag (cheap cross-isolate dedupe; a stuck
      flag older than 2× staleTime is ignored); miss → fetch inline, persist to KV +
      `cache_meta`. _Accepts:_ unit tests for all three paths and the stuck-flag case.
- [ ] **3.2 HTTP cache semantics.** Response helper adding `ETag` (content hash),
      `Last-Modified`, `Cache-Control: public, max-age=60, stale-while-revalidate=600`,
      `X-Fetched-At`, `X-Stale-At`; honour `If-None-Match` → 304. Apply to all schema/model
      read endpoints in Phase 4. _Accepts:_ test asserts 304 on matching ETag.

## Phase 4 — Public API (agent-first)

All under `/v1`, JSON-only, TanStack Start server-route handlers. Design for an LLM
consumer: every list response includes `_links` to drill deeper, errors carry remedies.

- [ ] **4.1 Discovery surface.** `GET /v1` (service description + endpoint index),
      `GET /llms.txt` (markdown usage guide for agents), `GET /openapi.json` (the
      service's own OpenAPI doc, hand-maintained in `src/server/openapi.ts`). _Accepts:_
      all three render; openapi.json validates against OpenAPI 3.1 meta-schema in a test.
- [ ] **4.2 Catalog endpoints.**
  - `GET /v1/providers` — list with sync status.
  - `GET /v1/providers/{provider}/models` — models for one provider.
  - `GET /v1/models?activity=&provider=&capability=&q=` — cross-provider catalog,
    filterable; this is the headline "what can I use right now" endpoint.
  - `GET /v1/models/{provider}/{modelId}` — full metadata + `_links.schemas`.
    _Accepts:_ curl each against seeded/synced local data; filters covered by tests.
- [ ] **4.3 Schema endpoints.**
  - `GET /v1/schemas/{provider}` — activities + endpoint ids.
  - `GET /v1/schemas/{provider}/{activity}` — endpoint-id-keyed map (current versions),
    mirroring the PR's `endpoint-schema-map` shape.
  - `GET /v1/schemas/{provider}/{activity}/{endpointId}?kind=input|output&version=` —
    single self-contained JSON Schema; defaults to current input schema.
    All via the SWR layer + ETag helper. _Accepts:_ schemas served byte-identical to D1
    content; 304s work; unknown ids → structured 404 with valid-id hints.
- [ ] **4.4 Validation endpoint.** `POST /v1/validate` with
      `{ provider, endpointId, kind?, payload }` → `{ valid, errors: [{ path, message, keyword }] }`
      using `@cfworker/json-schema`. _Accepts:_ test with one valid + one invalid
      Anthropic messages payload.
- [ ] **4.5 Changes feed.** `GET /v1/changes?since=&provider=&type=` (cursor-paginated)
      — the polling-friendly alternative to webhooks. _Accepts:_ cursor pagination test.

## Phase 5 — Agent signup & access control

Built on Better Auth's agent-auth plugin (https://better-auth.com/docs/plugins/agent-auth):
discovery → register → request capability grants → execute with short-lived JWTs.

- [ ] **5.1 Agent Auth provider surface.** Expose the discovery document at
      `/.well-known/agent-configuration` (route handler calling
      `auth.api.getAgentConfiguration()`). Declare capabilities in `agentAuth({...})`:
      derive the read/validate operations from our own `src/server/openapi.ts` doc via
      `createFromOpenAPI` (every Phase 4 operation has an `operationId`), and hand-declare
      `manage_subscriptions`. Autonomous mode is the default path (no human in the loop);
      delegated mode + approvals kept enabled but not required for any current capability.
      _Accepts:_ discovery doc renders; `POST /agent/register` → capability request →
      `POST /capability/execute` round-trips `get_schema` locally.
- [ ] **5.2 JWT verification on owned routes.** For agent-authed access to our native
      `/v1/*` routes (as opposed to the `/capability/execute` proxy), add a
      `requireAgent(request)` helper wrapping `verifyAgentRequest(request, auth)` +
      grant check, used by subscriptions (Phase 6) and `/v1/agents/me`. _Accepts:_ test
      hits a protected route with a valid agent JWT (200) and without (401).
- [ ] **5.3 API-key fallback.** `POST /v1/agents/register-key` `{ name, email? }` →
      Better Auth user + api-key plugin key, returned once; `Authorization: Bearer <key>`
      accepted everywhere `requireAgent` is — for agents that don't speak the agent-auth
      protocol. _Accepts:_ register → authed call with the key succeeds.
- [ ] **5.4 Rate limiting.** Per-agent/per-key and per-IP (anonymous) limits via
      Workers Rate Limiting binding (fallback: fixed-window counter in KV). Anonymous:
      60 req/h; authenticated: 5k req/h. 429s include `Retry-After`. _Accepts:_ test
      exhausts the anonymous window and sees 429.
- [ ] **5.5 Usage endpoint.** `GET /v1/agents/me` — agent identity, grants, limits,
      current usage. _Accepts:_ curl with agent JWT and with API key.

## Phase 6 — Push notifications

- [ ] **6.1 Subscriptions CRUD.** `POST|GET|DELETE /v1/subscriptions` (authed):
      url + events filter (+ optional provider filter). Secret generated server-side,
      returned once. _Accepts:_ CRUD round-trip test.
- [ ] **6.2 Webhook delivery.** On new `changes` rows, enqueue `webhook_deliveries`;
      deliver via `ctx.waitUntil` with HMAC-SHA256 signature header
      (`X-ModelSchemas-Signature`), JSON body `{ event, change, _links }`. Failures →
      exponential backoff via `nextAttemptAt`, drained by the 15-min cron; 8 failures →
      subscription auto-paused + recorded. _Accepts:_ integration test with a local
      receiver route capturing the signed payload.

## Phase 7 — Clients, MCP + DX polish

The service's own `openapi.json` (task 4.1, every operation has an `operationId`) is
the single source for three consumer surfaces: the generated TS client, the CLI, and
the agent-auth capability list (5.1). Spec drift breaks a CI check, not a user.

- [ ] **7.1 MCP server endpoint** at `/mcp` (streamable HTTP, Workers-native) exposing
      tools: `list_models`, `get_model`, `get_schema`, `validate_payload`,
      `recent_changes`. Reuse the Phase 4 service functions directly. _Accepts:_ MCP
      inspector (or a scripted client) lists tools and round-trips `get_schema`.
- [ ] **7.2 Minimal human dashboard.** `/` route: provider sync status, model counts,
      latest changes, docs links. Tailwind + shadcn; no auth needed (read-only).
      _Accepts:_ renders against local data.
- [ ] **7.3 Docs page** `/docs`: quickstart for agents (register → fetch schema →
      validate → subscribe), rendered from the same content as `llms.txt`. _Accepts:_
      renders; links resolve.
- [ ] **7.4 Generated TS client (`@modelschemas/client`).** Convert the repo to bun
      workspaces (`workspaces: ["packages/*"]`); add `packages/client` generated by
      `@hey-api/openapi-ts` (pin the version — PR #622 pinned 0.97.2 for a reason) from
      our spec: add `bun run openapi:emit` (writes `openapi.json` from
      `src/server/openapi.ts`) and `bun run generate:client`. Fetch-based client, typed
      per operation, pluggable auth (API key header or agent JWT). CI-style check script:
      regenerate → `git diff --exit-code` so the committed client never drifts from the
      spec. _Accepts:_ client compiles; smoke test against local dev lists providers and
      fetches one schema, fully typed.
- [ ] **7.5 CLI (`packages/cli`, bin: `modelschemas`).** Thin command layer over the
      generated client. `modelschemas login` runs agent-auth registration (autonomous
      mode by default; `--delegated` walks the device-authorization approval flow and
      polls until granted; `--api-key` falls back to `/v1/agents/register-key`), storing
      credentials in `~/.config/modelschemas/credentials.json` (0600). Commands:
      `models list|get`, `schema get <provider> <endpointId>`, `validate <endpointId> <file>`,
      `changes [--since]`, `subscribe <url> [--events]`, `whoami`. `--json` everywhere
      (default when not a TTY) so the CLI is itself agent-friendly. _Accepts:_
      `bun packages/cli login` against local dev creates an agent; `models list` then
      succeeds authenticated; `validate` returns non-zero exit on invalid payload.
- [ ] **7.6 Distributable agent skill.** `skill/modelschemas/SKILL.md` (frontmatter:
      `name`, `description` with trigger phrases like "model schema", "what models
      support X", "validate this provider payload") teaching the full workflow:
      discovery (`/.well-known/agent-configuration`, `llms.txt`) → auth via
      `modelschemas login` (or raw HTTP for keyless reads) → fetch/validate schemas →
      watch `/v1/changes`. Generate the endpoint reference section from the same source
      as `llms.txt` to avoid drift. Serve it: `GET /skill` returns the SKILL.md, linked
      from `/docs` and `llms.txt`. _Accepts:_ frontmatter valid; installing the dir into
      `.claude/skills/` and asking for an Anthropic chat schema produces a correct
      CLI/HTTP call sequence.

## Phase 8 — Ship

- [ ] **8.1 Production setup.** Create real D1 + KV resources, set IDs in
      `wrangler.jsonc`; `wrangler secret put` for `BETTER_AUTH_SECRET`, provider keys
      (`FAL_KEY`, `ELEVENLABS_API_KEY`, …), `ADMIN_KEY`. Document in README. _Accepts:_
      `bun run deploy` succeeds; `/v1/status` live.
- [ ] **8.2 First production sync.** Trigger admin sync for all providers; verify
      `/v1/models?activity=chat` returns real multi-provider data in prod. _Accepts:_
      spot-check Anthropic + OpenRouter schemas served with ETags.
- [ ] **8.3 Observability.** `wrangler.jsonc` `observability.enabled`, structured
      `console.log` JSON lines in cron handlers (provider, duration, changes count),
      README runbook for "a provider sync is failing". _Accepts:_ logs visible via
      `wrangler tail` during a manual sync.
- [ ] **8.4 Publish client + CLI.** npm publish `@modelschemas/client` and the
      `modelschemas` CLI (changesets or manual version bump); install instructions in
      README, `/docs`, and the skill. _Accepts:_ `bunx modelschemas@latest whoami`
      works against prod.
- [ ] **8.5 Update CLAUDE.md** with the new architecture (D1/KV bindings, cron
      entry point, ingest pipeline layout, workspace packages, API map) replacing the
      starter description. _Accepts:_ CLAUDE.md matches reality.
