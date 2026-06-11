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
  return presented === adminKey
}
