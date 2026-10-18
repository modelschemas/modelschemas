/** Admin-key gating + the JSON error envelope used by every API response. */

export function jsonError(
  status: number,
  code: string,
  message: string,
): Response {
  return Response.json({ error: { code, message } }, { status })
}

/**
 * Admin requests present the key via `X-Admin-Key` or `Authorization:
 * Bearer`. Always false when no ADMIN_KEY is configured — the admin surface
 * fails closed.
 */
export function isAdminRequest(
  request: Request,
  adminKey: string | undefined,
): boolean {
  if (!adminKey) return false
  const authorization = request.headers.get('authorization')
  const bearer = authorization?.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : null
  const presented = request.headers.get('x-admin-key') ?? bearer
  return presented !== null && sameKey(presented, adminKey)
}

/** Constant-time for a given key length, so timing does not leak a prefix. */
function sameKey(presented: string, expected: string): boolean {
  const a = new TextEncoder().encode(presented)
  const b = new TextEncoder().encode(expected)
  let diff = a.length ^ b.length
  for (let i = 0; i < b.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return diff === 0
}
