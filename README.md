# modelschemas

Live AI model schema service on Cloudflare Workers: per-endpoint
request/response JSON Schemas and model metadata for monitored providers
(OpenAI, Anthropic, Gemini, xAI Grok, ElevenLabs, OpenRouter, FAL, BytePlus),
with
react-query-style server-side caching (D1 source of truth, KV hot cache,
stale-while-revalidate) and automatic refresh — model lists every 15 minutes,
full OpenAPI spec syncs daily.

Surfaces:

- **HTTP API** under `/v1` — catalog, schemas, validation, changes feed
  (see `GET /v1` or [openapi.json](./openapi.json))
- **Agent guide** at `/llms.txt`, **agent skill** at `/skill`, **docs** at `/docs`
- **MCP server** at `/mcp` (streamable HTTP; tools: `list_models`,
  `get_model`, `get_schema`, `validate_payload`, `recent_changes`)
- **Agent auth** — agent-auth protocol discovery at
  `/.well-known/agent-configuration`, plus an API-key fallback
  (`POST /v1/agents/register-key`)
- **TS client** `@modelschemas/client` (packages/client, generated from the
  spec) and the **`modelschemas` CLI** (packages/cli)
- **Build-time pulls** — `@modelschemas/vite` (packages/vite) +
  `@modelschemas/codegen` (packages/codegen): commit selected schemas and
  generated TypeScript into your repo, fetched at dev time only

## Build-time schema pulls (vite plugin + CLI)

Pull self-contained TypeScript modules (JSON Schema const + generated
interfaces — pure exports, no barrel, tree-shakeable) into your project.
Files are committed; production builds touch zero network.

```ts
// vite.config.ts
import { modelschemas } from '@modelschemas/vite'

export default defineConfig({
  plugins: [
    modelschemas({
      selections: ['anthropic/v1/messages#request', 'openai/chat/*'],
      outDir: 'src/modelschemas', // default; commit it
      apiKey: process.env.MODELSCHEMAS_API_KEY, // optional — lifts rate limits
    }),
  ],
})
```

```ts
import {
  anthropicV1MessagesRequestSchema,
  type AnthropicV1MessagesRequest,
} from './modelschemas/anthropic/v1-messages.request.ts'
```

The dev server pulls whatever is missing and _reports_ upstream schema
drift (it never rewrites existing files); `modelschemas update` is the
explicit refresh and the git diff is the review. `vite build` only verifies
files match the `.manifest.json` lockfile — offline, reproducible. Without
vite: `modelschemas pull 'anthropic/*' --out src/modelschemas`. The raw
surface behind all of this is `?format=types` on any
`/v1/schemas/{provider}/{activity}/{endpointId}` read
(`?optional=undefined` for `exactOptionalPropertyTypes` consumers who
assign `undefined` explicitly). Verify locally end-to-end with
`bun scripts/pull-roundtrip.ts`.

## Provenance & verification

You don't have to trust that a schema served here matches its upstream —
every derivation is recorded and reproducible:

- **Provenance on every version.** Each stored schema version records the
  upstream document it was derived from: `sourceUrl`, `sourceHash`
  (SHA-256 of the document as fetched — for file-served specs,
  `curl -s <sourceUrl> | shasum -a 256` reproduces it), `fetchedAt`, and
  the `extractorVersion` that derived it.
  `GET /v1/schemas/{provider}/{activity}/{endpointId}` returns all of it
  alongside the schema.
- **Content-addressed schemas.** `contentHash` is the SHA-256 of the
  key-sorted schema JSON; it doubles as the ETag and the
  `?version=<contentHash>` address, so a pinned version is immutable by
  construction.
- **Re-derive the hashes yourself.** The extraction pipeline is this repo;
  `bun scripts/rederive.ts <provider>` runs the same
  fetchSpec → classify → bundle → hash pipeline the sync engine runs
  (shared code, `classifyAndBundle`) directly against the upstream spec —
  no service, no database — and prints every endpoint's `contentHash`.
  Matching hashes prove the served schema is exactly what the upstream
  document derives to. If they differ, compare `sourceHash` first: the
  upstream usually moved after the service's last daily sync.
- **Verify your pulls.** `modelschemas verify` checks committed files
  against the `.manifest.json` lockfile, then re-fetches every entry at
  its pinned `?version=<contentHash>` address, recomputes the hash
  locally, and exits non-zero on any mismatch — so pulled schemas keep
  matching their content addresses, with each check's provenance telling
  you which upstream document to audit.

## Examples

Three TanStack Start apps in [`examples/`](./examples) exercise the
packages end-to-end: **schema-studio** (`@modelschemas/vite` pulls →
generative UI from JSON Schemas), **image-dimensions** (live image-model
discovery, supported dimensions drawn to scale), and **video-composer**
(request builder restricted to each video schema's allowed
model/aspect-ratio/duration values). `bun install`, then `bun run dev`
inside any example.

## Development

```bash
bun install
bun run dev              # dev server on http://localhost:3100 (NOT --bun)
bun run test             # vitest: unit + workers-pool projects (NOT --bun)
bun --bun run lint
bun run typecheck
bun --bun run build
```

Local data setup:

```bash
bun run db:migrate       # apply migrations to wrangler's local D1
bun run seed             # seed the 8 providers
bun run dev              # then, in another shell:
curl -X POST http://localhost:3100/v1/admin/sync/openrouter -H "X-Admin-Key: $ADMIN_KEY"
```

Secrets live in `.env.local` (see CLAUDE.md). Pull them from Doppler:

```bash
bun run secrets:pull     # Doppler `dev` → .env.local (strips DOPPLER_*)
```

`ADMIN_KEY` gates `POST /v1/admin/sync/{provider}`. Useful scripts:
`bun scripts/agent-roundtrip.ts` (agent-auth end-to-end),
`bun scripts/client-smoke.ts` (typed client), `bun run check:client`
(client/spec drift), `bun scripts/emit-skill.ts` (regenerate SKILL.md),
`bun scripts/rederive.ts <provider>` (re-derive schema hashes from the
upstream spec, no service needed).

## Production setup

1. Create resources and put their IDs in `wrangler.jsonc`:

   ```bash
   bunx wrangler d1 create modelschemas        # → d1_databases[0].database_id
   bunx wrangler kv namespace create SCHEMA_CACHE  # → kv_namespaces[0].id
   ```

2. Apply migrations and seed:

   ```bash
   bun run db:migrate:remote
   bun run seed -- --remote
   ```

3. Secrets (`wrangler secret put <NAME>`): `BETTER_AUTH_SECRET` (32+ random
   bytes), `ADMIN_KEY`, and optionally provider keys — `OPENAI_API_KEY`,
   `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY`,
   `ELEVENLABS_API_KEY`, `FAL_KEY`, `ARK_API_KEY`. Providers without keys are
   skipped with a recorded warning (OpenRouter needs none; Anthropic's spec
   sync is also keyless). `ARK_API_KEY` is the exception: it is optional and
   only upgrades BytePlus's model catalog from the embedded one to Ark's live
   listing — BytePlus still serves schemas and a catalog without it. Set the `BETTER_AUTH_URL` var in `wrangler.jsonc` to the
   deployed origin (agent JWT audiences are origin-bound).

   Rather than setting them one at a time, reconcile against Doppler:

   ```bash
   bun run secrets:check   # Doppler prd ↔ Worker (names only)
   bun run secrets:push    # apply (one wrangler secret bulk call)
   ```

   It runs locally against your existing Doppler and wrangler logins, so no
   token goes near CI. Doppler is the source of truth: every name in the
   config is pushed except the remove list (`DOPPLER_*` context vars, and
   `BETTER_AUTH_URL` which is already a wrangler `vars` binding).
   Secrets are written into a new Worker version rather
   than the live one (the live API refuses while an undeployed preview
   version exists); the next deploy inherits them. Nothing is ever deleted.
   Deliberately NOT a CI job: that would need a long-lived Doppler service
   token plus a Cloudflare API token in GitHub, turning repo write access
   into full production compromise.

4. Deploy and warm:

   ```bash
   bun run deploy
   curl https://<worker-url>/v1/status
   curl -X POST https://<worker-url>/v1/admin/sync/openrouter -H "X-Admin-Key: ..."
   ```

Cron triggers start automatically on deploy: `*/15 * * * *` (models poll +
webhook drain) and four spec-sync shards (`0/10/20/30 5 * * *`) — each shard
is its own invocation with its own subrequest/CPU budgets, FAL alone in
shard 0, the rest of the registry round-robined across the other three
(`SPEC_SYNC_SHARD_CRONS` in `src/server/ingest/sync.ts`).

### Continuous deploys (Workers Builds)

Pushes to `main` deploy via Cloudflare Workers Builds (dashboard → Workers
& Pages → `modelschemas` → Settings → Build → connect the GitHub repo).
Settings:

- **Build command:** `bun run build`
- **Deploy command:** `bun run deploy:ci` — applies pending D1 migrations
  (`wrangler d1 migrations apply modelschemas --remote`, by database name so
  a binding rename can't retarget it) and then `wrangler deploy`, which
  follows the build-emitted redirect (`.wrangler/deploy/config.json`) to the
  real worker config at `dist/server/wrangler.json`. Deploying the repo-root
  `wrangler.jsonc` directly will not work.
- **Non-production branch deploy command:** leave as the default
  `npx wrangler versions upload` — preview versions share the production D1
  binding, so migrations must never run from non-production branches.

`bun run deploy` remains the manual/emergency path (build + the same
migrate-then-deploy).

## Releasing on npm

Four public packages (`0.1.0` is on the registry):

| Package                        | Directory          |
| ------------------------------ | ------------------ |
| `@modelschemas/client`         | `packages/client`  |
| `@modelschemas/codegen`        | `packages/codegen` |
| `@modelschemas/vite`           | `packages/vite`    |
| `modelschemas` (CLI, unscoped) | `packages/cli`     |

CI **never** holds an npm token. `.github/workflows/publish.yml` packs
with Bun (rewrites `workspace:*`), then `npm stage publish` over GitHub
OIDC. A human 2FA-approves each staged version before it is installable.

### One-time bootstrap (you, on npmjs.com + a laptop)

`npm trust` and `npm stage publish` both require the package to already
exist, so the first `0.1.0` of each cannot go through the Actions job.

1. Create the `@modelschemas` org at
   [npmjs.com/org/create](https://www.npmjs.com/org/create). Enable 2FA on
   the publishing account.
2. Pack locally, then publish the tarballs with an interactive 2FA
   prompt. Order is client → codegen → vite → CLI (workspace dependents
   last):

   ```bash
   bun scripts/npm-pack.ts --pack-dir /tmp/modelschemas-npm
   cd /tmp/modelschemas-npm
   npm login
   npm publish modelschemas-client-0.1.0.tgz --access public
   npm publish modelschemas-codegen-0.1.0.tgz --access public
   npm publish modelschemas-vite-0.1.0.tgz --access public
   npm publish modelschemas-0.1.0.tgz --access public
   ```

3. Bind each package to this repo's publish workflow (**stage-only**,
   environment name `npm` — must match the GitHub Environment exactly):

   ```bash
   npm install -g npm@11.19.0  # trust/stage need >= 11.15; npm 12 wants Node 24.15+
   for pkg in @modelschemas/client @modelschemas/codegen @modelschemas/vite modelschemas
   do
     npm trust github "$pkg" \
       --file publish.yml \
       --repo modelschemas/modelschemas \
       --env npm \
       --allow-stage-publish
   done
   ```

4. On each package: **Settings → Publishing access → Require two-factor
   authentication and disallow tokens → Update Package Settings**.
   Delete any granular tokens that can still publish.
5. GitHub repo **Settings → Environments → `npm`**: required reviewer
   (you); deployment branches limited to `main` and tags `v*`.

### Ongoing releases

1. Bump the four `package.json` versions together. Commit.
2. Tag `vX.Y.Z` matching those versions (or create a GitHub Release
   whose tag is that name) and push the tag.
3. Actions runs CI, packs, then (after the `npm` environment approval)
   `npm stage publish`. Inspect the tarball artifacts on the run.
4. On [npmjs.com](https://www.npmjs.com) → **Staged Packages**, 2FA-approve
   in the same order as bootstrap. Until you approve, `npm install` cannot
   see the version.

Dry-run the pipeline without staging:

```bash
# Actions → Publish → Run workflow, leave dry_run checked
# or locally:
bun scripts/npm-pack.ts --pack-dir dist/npm --tag v0.1.0
```

Do not add `NPM_TOKEN` / `NODE_AUTH_TOKEN` to GitHub Secrets. `bun publish`
is token-auth only and is not used for releases.

## Runbook: a provider sync is failing

1. `GET /v1/status` — the failing provider shows `status: "degraded"` and a
   stale `lastSyncedAt`/`lastPolledAt`.
2. Tail logs during a manual sync (`observability.enabled` is on, so the
   dashboard's Workers Logs works too):

   ```bash
   bunx wrangler tail modelschemas --format pretty
   # in another shell:
   curl -X POST https://<worker-url>/v1/admin/sync/<provider> -H "X-Admin-Key: ..."
   ```

   Cron handlers log structured JSON lines:
   `{"job":"models-poll"|"spec-sync"|"webhooks", outcomes:[{providerId, error?, skipped?, ...}]}`.

3. Interpret the outcome:
   - `skipped: "<provider>: X_API_KEY not set"` → set the secret
     (`wrangler secret put X_API_KEY`) or ignore if intentional.
   - `error: "fetch failed: <url> → 4xx/5xx"` → the upstream spec/models URL
     moved or is down; check `providers.spec_source_url` (seeded from
     `src/db/seed-providers.ts`) against the provider's docs.
   - Dangling-`$ref` warnings → the upstream spec changed shape; see
     `src/server/ingest/bundle.ts`.
4. One provider failing never sinks the run (per-provider isolation); fix
   and re-trigger with the admin sync endpoint. Schema history is preserved
   across failures — superseded versions stay queryable via
   `?version=<contentHash>`.

## Architecture

See `CLAUDE.md` for the operational map and `PLAN.md` for the full build
history (every task, decision, and gotcha). Borrows the provider-registry,
activity-grouping, and `$defs`-bundling design from TanStack AI PR #622,
re-implemented as a runtime service (no codegen) on Workers.
