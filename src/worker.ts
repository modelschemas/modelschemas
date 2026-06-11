import serverEntry from '@tanstack/react-start/server-entry'
import type {
  ExecutionContext,
  ScheduledController,
} from '@cloudflare/workers-types'

import type { DbEnv } from '#/db/index.ts'

// Not exported: workerd treats named exports of the entry module as
// entrypoints and requires them to be functions/ExportedHandlers.
const MODELS_POLL_CRON = '*/15 * * * *'
const SPEC_SYNC_CRON = '0 5 * * *'

export interface WorkerEnv extends DbEnv {}

export default {
  fetch: serverEntry.fetch,

  scheduled(
    controller: ScheduledController,
    _env: WorkerEnv,
    _ctx: ExecutionContext,
  ): void {
    switch (controller.cron) {
      case MODELS_POLL_CRON:
        // Phase 2 (task 2.5): pollAllModels(env, ctx)
        console.log(
          JSON.stringify({ cron: controller.cron, job: 'models-poll' }),
        )
        break
      case SPEC_SYNC_CRON:
        // Phase 2 (task 2.5): syncAllSchemas(env, ctx)
        console.log(JSON.stringify({ cron: controller.cron, job: 'spec-sync' }))
        break
      default:
        console.log(
          JSON.stringify({ cron: controller.cron, job: 'unknown-cron' }),
        )
    }
  },
}
