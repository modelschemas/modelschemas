import type { FactSource, UpstreamModelIdentity } from './types.ts'

/** Split a provider-published `namespace/model` id at the first slash. */
export function namespacedUpstreamIdentity(
  rawId: string,
  source: FactSource,
): UpstreamModelIdentity | null {
  const slash = rawId.indexOf('/')
  if (slash <= 0 || slash === rawId.length - 1) return null
  return {
    providerNamespace: rawId.slice(0, slash),
    rawId: rawId.slice(slash + 1),
    source,
  }
}
