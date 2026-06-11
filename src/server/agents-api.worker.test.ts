import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'

import { getDb } from '../db/index.ts'
import { createAuth } from '../lib/auth.ts'
import { parseRegisterKeyBody, registerKeyAgent } from './agents-api.ts'
import { requireAgent } from './require-agent.ts'

const makeAuth = () =>
  createAuth(getDb(env), {
    secret: 'vitest-only-better-auth-secret-0123456789',
    baseUrl: 'http://keys.test',
  })

const keyedRequest = (headers: Record<string, string>) =>
  new Request('http://keys.test/v1/agents/me', { headers })

describe('registerKeyAgent + API-key requireAgent', () => {
  it('registers and authenticates with the returned key', async () => {
    const auth = makeAuth()
    const outcome = await registerKeyAgent(auth, getDb(env), {
      name: 'Keyed Agent',
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.result.key).toBeTruthy()
    expect(outcome.result.note).toContain('once')

    const viaBearer = await requireAgent(
      auth,
      keyedRequest({ authorization: `Bearer ${outcome.result.key}` }),
    )
    expect(viaBearer.ok).toBe(true)
    if (viaBearer.ok) {
      expect(viaBearer.principal.kind).toBe('api-key')
      expect(viaBearer.principal.userId).toBe(outcome.result.userId)
    }

    // X-Api-Key works too, and API keys pass capability checks.
    const viaHeader = await requireAgent(
      auth,
      keyedRequest({ 'x-api-key': outcome.result.key }),
      { capability: 'manage_subscriptions' },
    )
    expect(viaHeader.ok).toBe(true)
  })

  it('rejects invalid keys with a 401', async () => {
    const auth = makeAuth()
    const result = await requireAgent(
      auth,
      keyedRequest({ authorization: 'Bearer ms_not_a_real_key' }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.response.status).toBe(401)
      const body = (await result.response.json()) as { error: { code: string } }
      expect(body.error.code).toBe('invalid_api_key')
    }
  })

  it('uses a custom email when provided and validates bodies', async () => {
    const auth = makeAuth()
    const outcome = await registerKeyAgent(auth, getDb(env), {
      name: 'Mail Agent',
      email: 'mail-agent@example.com',
    })
    expect(outcome.ok).toBe(true)

    // Duplicate email → structured failure, not a throw.
    const dup = await registerKeyAgent(auth, getDb(env), {
      name: 'Mail Agent 2',
      email: 'mail-agent@example.com',
    })
    expect(dup).toMatchObject({ ok: false, status: 409 })

    expect(parseRegisterKeyBody({ name: 'x' })).toEqual({
      name: 'x',
      email: undefined,
    })
    expect(parseRegisterKeyBody({ name: '  ' })).toBeNull()
    expect(parseRegisterKeyBody({})).toBeNull()
    expect(parseRegisterKeyBody({ name: 'x', email: 5 })).toBeNull()
  })
})
