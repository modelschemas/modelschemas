# modelschemas

Live AI model schema service on Cloudflare Workers: per-endpoint
request/response JSON Schemas and model metadata for monitored providers
(OpenAI, Anthropic, Gemini, xAI Grok, ElevenLabs, OpenRouter, FAL, BytePlus),
with
react-query-style server-side caching (D1 source of truth, KV hot cache,
stale-while-revalidate) and automatic refresh — model lists every 15 minutes,
full OpenAPI spec syncs daily.

Surfaces:

- **HTTP API** under `/v1` — catalog, schemas, validation, cost estimate,
  changes feed (see `GET /v1` or [openapi.json](./openapi.json))
- **Agent guide** at `/llms.txt`, **agent skill** at `/skill`, **docs** at `/docs`
- **MCP server** at `/mcp` (streamable HTTP; tools: `list_models`,
  `get_model`, `get_schema`, `validate_payload`, `estimate_cost`,
  `recent_changes`)
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

### Same model at another provider

A model row carries `sameAs: { provider, rawId }` when its own provider names
the upstream model — a gateway id such as `anthropic/claude-opus-4.5`, or
Azure's OpenAI model ids — and that model has a catalog row. It is a link
only: the row's price, limits, and other facts stay its own provider's.

- Within the named provider an exact id wins, then a documented alias, then
  the same with dots read as hyphens (`claude-opus-4.5` → `claude-opus-4-5`).
- `sameAs` is `null` when no upstream is stated, or the stated one matches no
  row or more than one. Priced variants such as `:batch` stay unlinked.
- `factSources.sameAs` records the source when the link is set, with
  `normalized: true` for a dots-as-hyphens match. Detail responses include
  it; `/v1/models` includes it with `?provenance=1`.
- Links refresh on each model poll (every 15 minutes) and a change emits
  `model.updated`.

### Capability flags, dates and provider metadata

`null` means "we do not know" on every model field.

- `capabilities` (`Record<string, boolean> | null`) is a map of flags:
  `{ "tools": true, "reasoning": false }`. `true`: the provider states the
  model supports it. `false`: the provider states it does not. Key absent:
  unknown. Never read a missing key as `false`; test
  `capabilities?.tools === true` to offer a feature and `=== false` to rule
  it out. `factSources.capabilities[flag]` is the source of each entry, a
  `true` and a `false` alike; a `false` whose source has `path: 'unlisted'`
  comes from the provider publishing the model's whole flag list without
  that flag. `?capability=tools` matches rows whose map has that flag set
  to `true` (exact flag name).
- `providerMetadata` (`object | null`): the provider's own listing object,
  as published and not normalised (fal `category`, BytePlus Ark features,
  ElevenLabs languages, Replicate visibility, Reactor pricing name). It is
  different for every provider and nothing in it is a capability flag.
- `releasedAt` (epoch seconds `| null`): the provider's own stated release
  or creation date. `firstSeenAt` still holds that date when there is one
  and our first observation otherwise; `releasedAt` is how to tell them
  apart. A row keeps its date when a listing stops stating it.
- `knowledgeCutoff` (`string | null`): `YYYY-MM`, or `YYYY-MM-DD` when the
  provider states a day. Never padded.
- `openWeights` (`boolean | null`) and `weightsUrl` (`string | null`): true
  only when the provider itself states the weights can be downloaded, with
  its link; false only when it states they cannot. Never inferred from a
  model name.

`knowledgeCutoff` and `openWeights` are null on every row until provider
adapters fill them. A row's first `releasedAt` and first `providerMetadata`
are written without a `model.updated` change; a later change emits one.

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

`ADMIN_KEY` gates `POST /v1/admin/sync/{provider}` and
`POST /v1/admin/extract/fal`. Useful scripts:
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
   listing — BytePlus still serves schemas and a catalog without it.
   `GITHUB_TOKEN` is optional too. When set, `api.github.com` requests send
   `Authorization: Bearer` (the Cloudflare AI Gateway catalog listing). A
   classic personal access token with no scopes is enough to leave the
   anonymous 60-requests-per-hour quota that shared Worker egress exhausts.
   `raw.githubusercontent.com` fetches, including the BytePlus Go SDK, stay
   unauthenticated, and both polls still run when the token is absent. Set
   the `BETTER_AUTH_URL` var in `wrangler.jsonc` to the deployed origin
   (agent JWT audiences are origin-bound).

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
webhook drain), four spec-sync shards (`0/10/20/30 5 * * *`) — each shard
is its own invocation with its own subrequest/CPU budgets, FAL alone in
shard 0, the rest of the registry round-robined across the other three
(`SPEC_SYNC_SHARD_CRONS` in `src/server/ingest/sync.ts`) — and six hourly
firings `0 6-11 * * *` for the FAL per-endpoint `llms.txt` rate-card
extract (`FAL_PRICING_EXTRACT_CRONS`), each covering ~250 endpoints so the
whole FAL roster is walked in one calendar day. Most Pricing sections are a
single unit rate and compile with no model call; only the multi-rate ones
go to the extract model, once per distinct Pricing-section hash. Force one
shard's worth with `POST /v1/admin/extract/fal`;
`POST /v1/admin/sync/fal` stays spec-only.

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

**Breaking (0.1.x):** `capabilities` is a map of booleans, not a list of
flag names: `["tools", "reasoning"]` is now `{ "tools": true, "reasoning":
true }`, and a flag the provider states the model does not support is
`false`. Replace `capabilities.includes('tools')` with
`capabilities?.tools === true`. A missing key is unknown, not `false`. The
provider-native objects five providers kept in `capabilities` (fal
`{ category }`, BytePlus, ElevenLabs, Replicate, Reactor) moved to the new
`providerMetadata` field, so `capabilities` is a boolean map or `null` on
every row. `?capability=` matches a flag set to `true` by exact name; it
was a substring match over the stored JSON, so `?capability=text-to-image`
(a fal category) no longer matches anything. Use `?activity=` or read
`providerMetadata.category`.

**Added (0.1.x):** model rows gain `releasedAt`, `knowledgeCutoff`,
`openWeights`, `weightsUrl` and `providerMetadata`, all nullable
("Capability flags, dates and provider metadata" above).

Both need D1 migrations `0013` (columns) and `0014` (stored capability
lists become maps; native objects move to `provider_metadata`). Migrate
first, then deploy: `bun run deploy:ci` does both in that order.

**Breaking (0.1.x):** `reasoning.mode` gains `toggle` (an on/off thinking
switch and nothing else), and `reasoning.mandatory` is `boolean | null`.
`null` means the provider's source does not say whether thinking can be
turned off. It must NOT be read as `false`: `if (!reasoning.mandatory)`
now misreads it, so test `reasoning.mandatory === false` before offering
an off option. `efforts` is never present on `toggle`, a `toggle` row
always has a stated `mandatory`, and a `switch (mode)` needs a `toggle`
case. `true` means the provider states thinking cannot be turned off —
but rows written before this rule also store `true` when a level list
merely has no `none`. Until those adapters are converted, treat `true` as
"inferred" on `openai`, `vercel`, `amazon-bedrock` (effort rows),
`mistral`, `groq`, `grok`, `zai`, `moonshotai-cn`, `baseten`, `byteplus`,
`fal`, and on the `effort` rows of `gemini` and `google-vertex`.

**Breaking (0.1.x):** `models.pricing` is a RateCard or `null`, not an
OpenRouter `{ prompt, completion, … }` blob. List rows carry a summary of
the stored card — `{ per: 'token', inputPerMillion, outputPerMillion }` at
the base rate (`tiered: true` when long prompts re-quote), or
`{ per: 'second' | 'character' | 'image' | 'request' }` for a card billed
by unit — so `null` on a list row always means no card. `GET
/v1/models?pricing=1` and model detail return the full card, and
`GET /v1/status` counts `priced` models per provider. Together all-zero placeholders are
`null`. `POST /v1/estimate` evaluates a stored card.

**Currencies:** rate cards may be in a currency other than USD.
`moonshotai-cn` and `minimax-cn` are priced in CNY. A USD card is unchanged;
a card in another currency wraps its price as
`{ "currency": ["CNY", <expression>] }` (ISO 4217), and that wrapper is the
only place the currency is stated. `price()` returns an amount in the
card's currency. **`@modelschemas/rate-card` 0.1.0 cannot read non-USD
cards: it rejects them at parse and `price()` throws `unknown-op`, so it
refuses rather than report yuan as dollars. Upgrade to read them.**
`/v1/estimate` and `estimate_cost` return `{ amount, currency }`; `usd` is
present only for USD cards and is deprecated. List summaries always include
`currency`. Nothing is converted, so amounts in different currencies never
compare.

Cards come from each host's own source — the OpenRouter, Together and xAI
listings (`listing`), and the OpenAI, Anthropic and Gemini pricing pages
(`docs-derived`); `factSources.pricing` says which. Token models carry
their cache, media-token and long-prompt rates; models billed by the
second, the minute, the character, the image or the request carry a
`quantity × rate[size]` card instead. What a source does not state, a card
does not guess: an unrecognised surcharge, a rate keyed on something the
request cannot express, or an alias the pricing page never names leaves the
model with no card rather than a partial one. A card is re-read when its
source text changes, or once the `expiresAt` of a dated price change has
passed.

Five public packages (`0.1.0` is on the registry; `@modelschemas/rate-card` from its bootstrap):

| Package                        | Directory            |
| ------------------------------ | -------------------- |
| `@modelschemas/client`         | `packages/client`    |
| `@modelschemas/codegen`        | `packages/codegen`   |
| `@modelschemas/rate-card`      | `packages/rate-card` |
| `@modelschemas/vite`           | `packages/vite`      |
| `modelschemas` (CLI, unscoped) | `packages/cli`       |

CI **never** holds an npm token. `.github/workflows/publish.yml` packs
with Bun (rewrites `workspace:*`), then `npm stage publish` over GitHub
OIDC. A human 2FA-approves each staged version before it is installable.

### Bootstrap (done 2026-08-21)

`npm trust` and `npm stage publish` require the package to already exist,
so the first version of each name was a laptop `npm publish` with 2FA,
then stage-only trusted publishers. Repeat that only when adding a **new
package name**.

Trusted-publisher config on every package must match:

```bash
npm install -g npm@11.19.0  # trust/stage need >= 11.15; npm 12 wants Node 24.15+
npm trust github <name> \
  --file publish.yml \
  --repo modelschemas/modelschemas \
  --env npm \
  --allow-stage-publish
```

Each package: **Settings → Publishing access → Require two-factor
authentication and disallow tokens**. GitHub Environment `npm`: required
reviewer; deployment branches limited to `main` and tags `v*`.

### Ongoing releases

1. Bump the five `package.json` versions together. Commit.
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
bun scripts/npm-pack.ts --pack-dir dist/npm
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
   - `docsFailing` on a `/v1/status` provider (a `docs` marker on the home
     page) → a docs page stopped loading or changed shape. Polls go on and
     `status` stays as it was; the docs-derived facts are frozen at their
     stored values. `sources` and `error` name the page: fix its parser in
     the provider's adapter. The next poll whose docs all load clears it.
   - `priceClearsRefused` on a `/v1/status` provider (a `prices` marker) →
     a poll asked to clear `refused` of `priced` stored prices and none was
     cleared. Either the adapter misreads a reshaped listing (fix it), or
     the prices really are gone (null the stale cards by hand in D1). The
     next poll that refuses nothing clears it.
   - Both records are written and cleared only by a poll whose listing
     loads. While the listing itself fails (`lastPolledAt` stalls) they stay
     as last written, with an old `lastAt`.
   - `completeness.score` null for every provider and
     `completenessComputedAt` null → no score is stored, as after a deploy
     that changes the scorer. The 15-minute poll cron computes it; trigger
     that cron to force a recompute. A failed computation logs
     `{"job":"completeness","error":…}` and keeps the previous scores.
4. One provider failing never sinks the run (per-provider isolation); fix
   and re-trigger with the admin sync endpoint. Schema history is preserved
   across failures — superseded versions stay queryable via
   `?version=<contentHash>`.

## Architecture

See `CLAUDE.md` for the operational map. `PLAN.md` is the completed build
log (not the backlog). Borrows the provider-registry,
activity-grouping, and `$defs`-bundling design from TanStack AI PR #622,
re-implemented as a runtime service (no codegen) on Workers.
