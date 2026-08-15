import serverEntry from '@tanstack/react-start/server-entry'

import { getDb } from '#/db/index.ts'
import type { DbEnv } from '#/db/index.ts'
import { isAdminRequest } from '#/server/admin.ts'
import { getAuth } from '#/server/auth.ts'
import type { KvEnv } from '#/server/kv.ts'
import type { ProviderSecrets } from '#/server/providers/types.ts'
import { withDiscoveryLinks } from '#/server/discovery-links.ts'
import {
  markdownForPath,
  markdownResponse,
  wantsMarkdown,
} from '#/server/markdown-pages.ts'
import { narrativeRoot, wantsJsonRoot } from '#/server/narrative.ts'
import { enforceRateLimit } from '#/server/rate-limit.ts'
import { pollAllProviders } from '#/server/ingest/poll-models.ts'
import {
  SPEC_SYNC_SHARD_CRONS,
  specSyncShard,
  syncAllProviders,
} from '#/server/ingest/sync.ts'
import { runWebhookTick } from '#/server/webhooks.ts'
import type { SyncDeps } from '#/server/ingest/sync.ts'

// Not exported: workerd treats named exports of the entry module as
// entrypoints and requires them to be functions/ExportedHandlers.
const MODELS_POLL_CRON = '*/15 * * * *'

export interface WorkerEnv extends DbEnv, KvEnv, ProviderSecrets {
  ADMIN_KEY?: string
}

function syncDeps(env: WorkerEnv): SyncDeps {
  return { db: getDb(env), kv: env.SCHEMA_CACHE, secrets: env }
}

/**
 * Public reads are keyless JSON meant for any client — including browser
 * apps (the hosted examples fetch /v1/schemas live). CORS-open GETs on the
 * read surface; admin and auth routes are excluded.
 */
function isCorsReadPath(pathname: string): boolean {
  return (
    (pathname.startsWith('/v1/') && !pathname.startsWith('/v1/admin/')) ||
    pathname === '/openapi.json' ||
    pathname === '/llms.txt'
  )
}

function withCors(response: Response): Response {
  // New Response: framework responses can carry immutable headers.
  const wrapped = new Response(response.body, response)
  wrapped.headers.set('Access-Control-Allow-Origin', '*')
  return wrapped
}

export default {
  async fetch(
    request: Request,
    env: WorkerEnv,
    ctx: ExecutionContext,
  ): Promise<Response> {
    // Rate limit the public API (admin-keyed requests are exempt; auth
    // endpoints have agent-auth's own protections).
    const url = new URL(request.url)
    const { pathname } = url
    const corsRead =
      isCorsReadPath(pathname) &&
      (request.method === 'GET' || request.method === 'HEAD')
    if (request.method === 'OPTIONS' && isCorsReadPath(pathname)) {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, If-None-Match',
          'Access-Control-Max-Age': '86400',
        },
      })
    }
    if (
      pathname.startsWith('/v1/') &&
      !isAdminRequest(request, env.ADMIN_KEY)
    ) {
      const limited = await enforceRateLimit(
        getAuth(),
        getDb(env),
        env.SCHEMA_CACHE,
        request,
      )
      if (limited) return corsRead ? withCors(limited) : limited
    }
    // Narrative API root (task 11.2): JSON-accepting GET / gets the MCP
    // initialize instructions document instead of the SSR landing page.
    if (pathname === '/' && wantsJsonRoot(request)) {
      const body = Response.json(narrativeRoot(url.origin))
      body.headers.set('Vary', 'Accept')
      return body
    }
    // Markdown content negotiation (task 10.5): Accept: text/markdown on an
    // HTML page returns markdown instead of SSR.
    if (wantsMarkdown(request)) {
      const md = markdownForPath(pathname, url.origin)
      if (md !== null) return markdownResponse(md)
    }
    // TanStack Start's handler takes (request, opts?) — bindings flow in via
    // the cloudflare:workers env module, not handler arguments. HTML pages
    // get RFC 8288 discovery Link headers (task 10.2).
    void ctx
    const response = withDiscoveryLinks(await serverEntry.fetch(request))
    return corsRead ? withCors(response) : response
  },

  scheduled(
    controller: ScheduledController,
    env: WorkerEnv,
    ctx: ExecutionContext,
  ): void {
    // The models poll runs the full registry in one invocation; the spec
    // sync is sharded across several cron firings so each shard gets its
    // own subrequest/CPU/memory budgets (see SPEC_SYNC_SHARD_CRONS). Work
    // inside each invocation stays sequential with per-provider isolation.
    if (controller.cron === MODELS_POLL_CRON) {
      ctx.waitUntil(
        pollAllProviders(syncDeps(env))
          .then((outcomes) => {
            console.log(JSON.stringify({ job: 'models-poll', outcomes }))
            // The 15-min cron also drains the webhook queue (task 6.2).
            return runWebhookTick(getDb(env))
          })
          .then(({ enqueued, outcomes }) => {
            console.log(JSON.stringify({ job: 'webhooks', enqueued, outcomes }))
          }),
      )
      return
    }
    const shard = (SPEC_SYNC_SHARD_CRONS as ReadonlyArray<string>).indexOf(
      controller.cron,
    )
    if (shard >= 0) {
      ctx.waitUntil(
        syncAllProviders(syncDeps(env), specSyncShard(shard)).then(
          (outcomes) => {
            // Summarize warnings to a count: hundreds of dangling-ref lines
            // push the blob past what Workers Logs stores, losing the log.
            const summary = outcomes.map(({ warnings, ...rest }) => ({
              ...rest,
              warningCount: warnings.length,
            }))
            console.log(
              JSON.stringify({ job: 'spec-sync', shard, outcomes: summary }),
            )
          },
        ),
      )
      return
    }
    console.log(JSON.stringify({ cron: controller.cron, job: 'unknown-cron' }))
  },
}
