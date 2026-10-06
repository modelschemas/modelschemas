/**
 * `?wait=` long-poll support (PLAN.md task 11.3). Agents rarely have a
 * sleep tool: `?wait=30` (or `30s`) on /v1/changes and /v1/status holds
 * the request — polling D1 every ~2s inside the request, no cron involved —
 * until new data lands or the window expires, then returns whatever is
 * current. Rate limiting happens once per request in the worker fetch
 * wrapper, so a held request still costs one rate-limit token.
 */
import { desc, max } from 'drizzle-orm'

import type { Db } from '#/db/index.ts'
import { changes, providers } from '#/db/schema.ts'

export const MAX_WAIT_SECONDS = 60
export const POLL_INTERVAL_MS = 2_000

/** Parses `?wait=30` / `?wait=30s`; 0 when absent or invalid; capped. */
export function parseWaitSeconds(url: URL): number {
  const raw = url.searchParams.get('wait')
  if (raw === null) return 0
  const match = /^(\d+)s?$/.exec(raw.trim())
  if (!match) return 0
  return Math.min(Number(match[1]), MAX_WAIT_SECONDS)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Polls `changed` every ~2s until it reports true or `seconds` elapse. */
export async function waitUntilChanged(
  changed: () => Promise<boolean>,
  seconds: number,
  pollIntervalMs = POLL_INTERVAL_MS,
): Promise<void> {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, deadline - Date.now()))
    if (await changed()) return
  }
}

async function latestChangeAt(db: Db): Promise<number> {
  const row = await db
    .select({ createdAt: changes.createdAt })
    .from(changes)
    .orderBy(desc(changes.createdAt))
    .limit(1)
  return row[0]?.createdAt ?? 0
}

/** Holds until a change newer than the baseline exists (or expiry). */
export async function waitForNewChange(
  db: Db,
  seconds: number,
  pollIntervalMs = POLL_INTERVAL_MS,
): Promise<void> {
  const baseline = await latestChangeAt(db)
  await waitUntilChanged(
    async () => (await latestChangeAt(db)) > baseline,
    seconds,
    pollIntervalMs,
  )
}

// Asked every ~2s while a request is held: two columns, not the whole
// status with its counts and completeness score.
async function latestStatusAt(db: Db): Promise<number> {
  const [row] = await db
    .select({
      polled: max(providers.lastPolledAt),
      synced: max(providers.lastSyncedAt),
    })
    .from(providers)
  return Math.max(row?.polled ?? 0, row?.synced ?? 0)
}

/** Holds until any provider polls/syncs past the baseline (or expiry). */
export async function waitForStatusChange(
  db: Db,
  seconds: number,
  pollIntervalMs = POLL_INTERVAL_MS,
): Promise<void> {
  const baseline = await latestStatusAt(db)
  await waitUntilChanged(
    async () => (await latestStatusAt(db)) > baseline,
    seconds,
    pollIntervalMs,
  )
}
