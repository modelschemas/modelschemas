import serverEntry from '@tanstack/react-start/server-entry'

import { getDb } from '#/db/index.ts'
import type { DbEnv } from '#/db/index.ts'
import { isAdminRequest } from '#/server/admin.ts'
import { getAuth } from '#/server/auth.ts'
import type { KvEnv } from '#/server/kv.ts'
import type { ProviderSecrets } from '#/server/providers/types.ts'
import { enforceRateLimit } from '#/server/rate-limit.ts'
import { pollAllProviders } from '#/server/ingest/poll-models.ts'
import { syncAllProviders } from '#/server/ingest/sync.ts'
import { runWebhookTick } from '#/server/webhooks.ts'
import type { SyncDeps } from '#/server/ingest/sync.ts'

// Not exported: workerd treats named exports of the entry module as
// entrypoints and requires them to be functions/ExportedHandlers.
const MODELS_POLL_CRON = '*/15 * * * *'
const SPEC_SYNC_CRON = '0 5 * * *'

export interface WorkerEnv extends DbEnv, KvEnv, ProviderSecrets {
  ADMIN_KEY?: string
}

function syncDeps(env: WorkerEnv): SyncDeps {
  return { db: getDb(env), kv: env.SCHEMA_CACHE, secrets: env }
}

export default {
  async fetch(
    request: Request,
    env: WorkerEnv,
    ctx: ExecutionContext,
  ): Promise<Response> {
    // Rate limit the public API (admin-keyed requests are exempt; auth
    // endpoints have agent-auth's own protections).
    const { pathname } = new URL(request.url)
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
      if (limited) return limited
    }
    // TanStack Start's handler takes (request, opts?) — bindings flow in via
    // the cloudflare:workers env module, not handler arguments.
    void ctx
    return serverEntry.fetch(request)
  },

  scheduled(
    controller: ScheduledController,
    env: WorkerEnv,
    ctx: ExecutionContext,
  ): void {
    // Each tier runs all providers inside one waitUntil; the per-provider
    // work is sequential inside pollAllProviders/syncAllProviders to respect
    // Workers subrequest limits, with per-provider failure isolation.
    switch (controller.cron) {
      case MODELS_POLL_CRON:
        ctx.waitUntil(
          pollAllProviders(syncDeps(env))
            .then((outcomes) => {
              console.log(JSON.stringify({ job: 'models-poll', outcomes }))
              // The 15-min cron also drains the webhook queue (task 6.2).
              return runWebhookTick(getDb(env))
            })
            .then(({ enqueued, outcomes }) => {
              console.log(
                JSON.stringify({ job: 'webhooks', enqueued, outcomes }),
              )
            }),
        )
        break
      case SPEC_SYNC_CRON:
        ctx.waitUntil(
          syncAllProviders(syncDeps(env)).then((outcomes) => {
            console.log(JSON.stringify({ job: 'spec-sync', outcomes }))
          }),
        )
        break
      default:
        console.log(
          JSON.stringify({ cron: controller.cron, job: 'unknown-cron' }),
        )
    }
  },
}
