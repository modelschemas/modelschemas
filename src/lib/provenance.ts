/** Recorded sources only: never construct upstream links from provider names. */
export function sourceHref(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:') &&
      !url.username &&
      !url.password
      ? value
      : null
  } catch {
    return null
  }
}
export interface RecordedSource {
  field: string
  sourceUrl: string | null
  sourceHash: string | null
  derivation: string | null
  path: string | null
  checkedAt: string | null
  trace: Record<string, unknown>
}
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
export function recordedSources(value: unknown, prefix = ''): RecordedSource[] {
  if (!record(value)) return []
  if ('derivation' in value || 'sourceUrl' in value || 'sourceHash' in value)
    return [
      {
        field: prefix,
        trace: Object.fromEntries(
          Object.entries(value).filter(
            ([key]) =>
              ![
                'sourceUrl',
                'sourceHash',
                'derivation',
                'path',
                'checkedAt',
              ].includes(key),
          ),
        ),
        sourceUrl: sourceHref(value.sourceUrl),
        sourceHash:
          typeof value.sourceHash === 'string' ? value.sourceHash : null,
        derivation:
          typeof value.derivation === 'string' ? value.derivation : null,
        path: typeof value.path === 'string' ? value.path : null,
        checkedAt: typeof value.checkedAt === 'string' ? value.checkedAt : null,
      },
    ]
  return Object.entries(value).flatMap(([field, source]) =>
    recordedSources(source, prefix ? `${prefix}.${field}` : field),
  )
}

/** A visible link represents a fact only when its recorded URL is identical. */
export function sourceLinkAlreadyShown(
  source: unknown,
  shownUrl: unknown,
): boolean {
  if (!record(source)) return false
  const recordedUrl = sourceHref(source.sourceUrl)
  return recordedUrl !== null && recordedUrl === sourceHref(shownUrl)
}
