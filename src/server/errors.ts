/**
 * Error text including the `cause` chain. Drizzle wraps the real D1 error
 * (e.g. `D1_ERROR: ...`) in a DrizzleQueryError whose own message is the
 * full SQL + params dump — without the chain the actual failure is lost.
 * Each link is truncated so query/params dumps can't bloat logs past what
 * Workers Logs stores.
 */
export function errorMessage(error: unknown, maxPartLength = 300): string {
  const parts: Array<string> = []
  let current: unknown = error
  while (current !== undefined && current !== null && parts.length < 5) {
    const text = current instanceof Error ? current.message : String(current)
    parts.push(
      text.length > maxPartLength ? `${text.slice(0, maxPartLength)}…` : text,
    )
    current = current instanceof Error ? current.cause : undefined
  }
  return parts.join(' ← caused by: ')
}
