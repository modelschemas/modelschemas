import serverEntry from '@tanstack/react-start/server-entry'
import type {
  ExecutionContext,
  ScheduledController,
} from '@cloudflare/workers-types'

import { getDb } from '#/db/index.ts'
import type { DbEnv } from '#/db/index.ts'
import type { KvEnv } from '#/server/kv.ts'
import type { ProviderSecrets } from '#/server/providers/types.ts'
import { pollAllProviders } from '#/server/ingest/poll-models.ts'
import { syncAllProviders } from '#/server/ingest/sync.ts'
import type { SyncDeps } from '#/server/ingest/sync.ts'

// Not exported: workerd treats named exports of the entry module as
// entrypoints and requires them to be functions/ExportedHandlers.
const MODELS_POLL_CRON = '*/15 * * * *'
const SPEC_SYNC_CRON = '0 5 * * *'

export interface WorkerEnv extends DbEnv, KvEnv, ProviderSecrets {}

function syncDeps(env: WorkerEnv): SyncDeps {
  return { db: getDb(env), kv: env.SCHEMA_CACHE, secrets: env }
}

export default {
  fetch: serverEntry.fetch,

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
          pollAllProviders(syncDeps(env)).then((outcomes) => {
            console.log(JSON.stringify({ job: 'models-poll', outcomes }))
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
