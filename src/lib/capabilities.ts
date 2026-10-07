/**
 * `models.capabilities` as stored and served: `true` = the provider states
 * the model supports the flag, `false` = the provider states it does not,
 * key absent = unknown. The whole field is null when nothing is known.
 */
export type CapabilityMap = Record<string, boolean>

export function isCapabilityMap(value: unknown): value is CapabilityMap {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((flag) => typeof flag === 'boolean')
  )
}

/** The flags a stored map says yes to. Anything but a map says none. */
export function supportedFlags(value: unknown): Array<string> {
  return isCapabilityMap(value)
    ? Object.keys(value).filter((flag) => value[flag])
    : []
}
