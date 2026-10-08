import { describe, expect, it } from 'vitest'

import { githubRequestInit } from './github.ts'

const API =
  'https://api.github.com/repos/cloudflare/cloudflare-docs/contents/src/content/catalog-models?ref=production'
const RAW =
  'https://raw.githubusercontent.com/byteplus-sdk/byteplus-go-sdk-v2/main/service/arkruntime/model/chat_completion.go'

function authorization(init: RequestInit): string | null {
  return new Headers(init.headers).get('Authorization')
}

describe('githubRequestInit', () => {
  it('sends the bearer token only to api.github.com', () => {
    const authed = githubRequestInit(API, { GITHUB_TOKEN: 'ghp_test' })
    expect(authorization(authed)).toBe('Bearer ghp_test')
    expect(new Headers(authed.headers).get('Accept')).toBe(
      'application/vnd.github+json',
    )
    expect(new Headers(authed.headers).get('User-Agent')).toBe('modelschemas')

    const raw = githubRequestInit(
      RAW,
      { GITHUB_TOKEN: 'ghp_test' },
      {
        headers: { 'User-Agent': 'modelschemas' },
      },
    )
    expect(authorization(raw)).toBeNull()
    expect(new Headers(raw.headers).get('User-Agent')).toBe('modelschemas')
  })

  it('stays anonymous when the token is missing or blank', () => {
    expect(authorization(githubRequestInit(API, {}))).toBeNull()
    expect(authorization(githubRequestInit(API, { GITHUB_TOKEN: '  ' }))).toBe(
      null,
    )
  })

  it('does not replace an Authorization header the caller already set', () => {
    const init = githubRequestInit(
      API,
      { GITHUB_TOKEN: 'ghp_test' },
      { headers: { Authorization: 'Bearer other' } },
    )
    expect(authorization(init)).toBe('Bearer other')
  })
})
