import { describe, expect, it } from 'vitest'

import { isAdminRequest, jsonError } from './admin.ts'

const req = (headers: Record<string, string> = {}) =>
  new Request('https://example.com/v1/admin/sync/openai', {
    method: 'POST',
    headers,
  })

describe('isAdminRequest', () => {
  it('accepts the key via X-Admin-Key or Authorization: Bearer', () => {
    expect(isAdminRequest(req({ 'x-admin-key': 'sekret' }), 'sekret')).toBe(
      true,
    )
    expect(
      isAdminRequest(req({ authorization: 'Bearer sekret' }), 'sekret'),
    ).toBe(true)
  })

  it('rejects wrong or missing keys', () => {
    expect(isAdminRequest(req({ 'x-admin-key': 'nope' }), 'sekret')).toBe(false)
    expect(isAdminRequest(req(), 'sekret')).toBe(false)
  })

  it('fails closed when no admin key is configured', () => {
    expect(isAdminRequest(req({ 'x-admin-key': 'anything' }), undefined)).toBe(
      false,
    )
    expect(isAdminRequest(req({ 'x-admin-key': '' }), '')).toBe(false)
  })
})

describe('jsonError', () => {
  it('produces the standard error envelope', async () => {
    const response = jsonError(404, 'unknown_provider', 'nope')
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      error: { code: 'unknown_provider', message: 'nope' },
    })
  })
})
