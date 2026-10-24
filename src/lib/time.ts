/**
 * Compact relative time for freshness signals ("6m ago"), measured from
 * `now` (epoch seconds). Pages pass the instant their server function ran,
 * so the server render and the browser's hydration print the same text.
 */
export function timeAgo(epochSeconds: number | null, now: number): string {
  if (!epochSeconds) return 'never'
  const delta = Math.max(0, now - epochSeconds)
  if (delta < 90) return `${String(delta)}s ago`
  if (delta < 5400) return `${String(Math.round(delta / 60))}m ago`
  if (delta < 129_600) return `${String(Math.round(delta / 3600))}h ago`
  return `${String(Math.round(delta / 86_400))}d ago`
}

/** Absolute date for provenance ("Jun 11, 2026"). */
export function shortDate(epochSeconds: number | null): string {
  if (!epochSeconds) return '—'
  return new Date(epochSeconds * 1000).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  })
}
