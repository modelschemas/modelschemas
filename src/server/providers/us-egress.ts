import type { ProviderEnvironment } from './types.ts'

/** What `fetchJson` calls; the global `fetch` is one. */
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>

/**
 * A fetch that leaves Cloudflare from eastern North America (issue #356).
 *
 * Anthropic and Gemini refuse callers in regions they do not serve
 * (`403 forbidden` / `400 User location is not supported`). Cron
 * invocations run wherever Cloudflare has spare capacity, and `placement`
 * only moves fetch handlers, so the models poll has no fixed location.
 * A Durable Object is created near its `locationHint` on the first `get()`
 * and does not move afterwards, so routing the keyed listing calls through
 * one fixes where they egress. (The `us` jurisdiction would be a hard
 * guarantee, but workerd does not implement it, so `bun run dev` would
 * throw.)
 *
 * No `US_EGRESS` binding (local scripts, unit tests): the global fetch,
 * which runs from the caller's own machine.
 */
export function usEgressFetch(env: ProviderEnvironment): Fetcher {
  const ns = env.US_EGRESS
  if (!ns) return fetch
  const stub = ns.get(ns.idFromName('provider-egress'), {
    locationHint: 'enam',
  })
  // workers-types' Request/Response and the DOM ones this file is typed
  // with are the same runtime classes.
  return async (url, init) =>
    (await stub.fetch(url, init as never)) as unknown as Response
}
