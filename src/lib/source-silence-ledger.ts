/** Exact provider/model scopes shared by scoring and read-time evidence. */
export interface LedgerEntry {
  scope: string
  provider: string
  rawId?: string
  fact: string
}

/** First slash separates the provider; the remaining native id is never normalized. */
export function modelLedgerScope(provider: string, rawId: string): string {
  return `${provider}/${rawId}`
}

/** Markdown prose is ignored; a recognized entry must have a valid scope. */
export function parseLedgerEntry(line: string): LedgerEntry | null {
  const match =
    /^- (?:`([^`]+)`|([^\s`]+)): (?:`([^`]+)`|([^\s`]+))(?=\s|$)/.exec(line)
  if (!match) {
    if (/^- (?:`[\w.-]+(?:\/[^`]*)?`|[\w.-]+(?:\/[^\s]*)?):/.test(line))
      throw new Error(`source-silent ledger: malformed entry: ${line}`)
    return null
  }
  const scope = match[1] ?? match[2]!
  const slash = scope.indexOf('/')
  const provider = slash < 0 ? scope : scope.slice(0, slash)
  const rawId = slash < 0 ? undefined : scope.slice(slash + 1)
  if (
    !/^[\w.-]+$/.test(provider) ||
    (rawId !== undefined && (!rawId || /\s/.test(rawId)))
  ) {
    throw new Error(`source-silent ledger: invalid scope "${scope}"`)
  }
  return {
    scope,
    provider,
    ...(rawId !== undefined ? { rawId } : {}),
    fact: match[3] ?? match[4]!,
  }
}
