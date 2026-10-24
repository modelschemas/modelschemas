/** String form of a primitive. Objects become '' instead of `[object Object]`. */
export function asText(value: unknown): string {
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return String(value)
  }
  return ''
}

export function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

export function bodyText(body: BodyInit | null | undefined): string {
  if (typeof body === 'string') return body
  if (body instanceof URLSearchParams) return body.toString()
  return ''
}
