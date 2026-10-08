import type { ProviderSecrets } from './types.ts'

const GITHUB_API_HOST = 'api.github.com'

/**
 * Attach `Authorization: Bearer` to `api.github.com` when `GITHUB_TOKEN` is
 * set. Workers share egress IPs, so the anonymous 60-requests-per-hour quota
 * is exhausted by other tenants and the contents API returns 403. A blank
 * token stays anonymous. `raw.githubusercontent.com` is a different host and
 * is returned unchanged.
 */
export function githubRequestInit(
  url: string,
  env: Pick<ProviderSecrets, 'GITHUB_TOKEN'>,
  init?: RequestInit,
): RequestInit {
  let host = ''
  try {
    host = new URL(url).host
  } catch {
    return init ?? {}
  }
  if (host !== GITHUB_API_HOST) return init ?? {}

  const headers = new Headers(init?.headers)
  if (!headers.has('Accept')) {
    headers.set('Accept', 'application/vnd.github+json')
  }
  if (!headers.has('User-Agent')) {
    headers.set('User-Agent', 'modelschemas')
  }
  const token = env.GITHUB_TOKEN?.trim()
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`)
  }
  return { ...init, headers }
}
