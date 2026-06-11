# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

A Cloudflare Workers service giving AI agents live access to model schemas: per-endpoint
request/response JSON Schemas and model metadata for every monitored provider, with
react-query-style server-side caching (persistent, stale-while-revalidate) and
auto-refresh when providers ship new models. Design borrows from TanStack AI PR #622
(`@tanstack/ai-schemas`).

**The build is driven by `PLAN.md`** — a phased, checkbox task list with its own loop
protocol and settled architecture decisions (D1 as source of truth + KV hot cache,
two-tier cron refresh, better-auth agent-auth for agent signup, hey-api-generated
client + CLI + skill from our own OpenAPI spec). Read PLAN.md before doing feature
work; don't relitigate its "Architecture decisions" section. The codebase is currently
the TanStack Start scaffold described below — the Commands/Architecture sections here
reflect what exists now, not the plan's end state, and PLAN.md task 8.5 updates them.

## Commands

This project uses Bun as the package manager/runtime.

```bash
bun install              # install dependencies
bun run dev              # dev server on port 3100 (NOT --bun: bun's ws shim hangs vite startup)
bun --bun run build      # production build
bun run test             # run all tests (NOT --bun: the cloudflare vitest pool needs node)
bun run test src/path/to/file.test.ts       # run a single test file
bun --bun run lint       # eslint (no-explicit-any + no-unsafe-* are errors)
bun run typecheck        # tsc --noEmit
bun --bun run format     # prettier --write + eslint --fix
bun --bun run check      # prettier --check
bun run deploy           # build + wrangler deploy (Cloudflare Workers)
```

Lefthook pre-commit hooks (installed via the `prepare` script) run prettier, eslint,
and typecheck — don't bypass them with `--no-verify`. The `any` type is banned by
lint; tsconfig has `strict` + `noUncheckedIndexedAccess` + `noImplicitOverride`.
Note: the Cloudflare vite plugin is skipped when running under vitest
(see `vite.config.ts`) — Workers-binding tests need `@cloudflare/vitest-pool-workers`
(PLAN.md task 0.3).

Database (Drizzle Kit, reads `DATABASE_URL` from `.env.local`/`.env`):

```bash
bun run db:generate      # generate migrations from schema
bun run db:migrate       # apply migrations
bun run db:push          # push schema directly to db
bun run db:studio        # drizzle studio
```

Add shadcn/ui components with the latest version of shadcn:

```bash
pnpm dlx shadcn@latest add button
```

## Architecture

TanStack Start (React 19, SSR) app deployed to Cloudflare Workers via the Cloudflare Vite plugin (`vite.config.ts`) and `wrangler.jsonc`. Styling is Tailwind CSS v4 (configured through the Vite plugin, no tailwind.config file). AI chat functionality uses the `@tanstack/ai` packages with provider adapters (Anthropic, OpenAI, Gemini, Ollama).

- **Routing**: File-based via TanStack Router. Routes live in `src/routes/`; `src/routeTree.gen.ts` is auto-generated (by the dev server or `bun run generate-routes`) — never edit it by hand. The root layout/document shell is `src/routes/__root.tsx`. API routes are route files with a `server.handlers` property (e.g. `src/routes/api/auth/$.ts`).
- **Server code**: Use `createServerFn` from `@tanstack/react-start` for server functions, or route loaders for data fetching.
- **Auth**: Better Auth, configured in `src/lib/auth.ts` (email/password + TanStack Start cookies plugin), exposed through the catch-all route `src/routes/api/auth/$.ts`. Client helpers in `src/lib/auth-client.ts`. Requires `BETTER_AUTH_SECRET` in `.env.local`.
- **Database**: Drizzle ORM over better-sqlite3. Schema in `src/db/schema.ts`, client in `src/db/index.ts`, Drizzle Kit config in `drizzle.config.ts` (migrations output to `./drizzle`).
- **Path aliases**: `#/*` and `@/*` both map to `./src/*` (see `tsconfig.json`). `allowImportingTsExtensions` is on — imports may include `.ts` extensions (e.g. `src/db/index.ts` imports `./schema.ts`).
- **Env vars**: `ANTHROPIC_API_KEY`, `BETTER_AUTH_SECRET`, `DATABASE_URL` go in `.env.local`. For production, secrets go via `wrangler secret put`; public vars in `wrangler.jsonc` under `vars`.

Files prefixed with `demo` are scaffold examples and can be safely deleted.
