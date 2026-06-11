import { beforeAll, describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'
import { SignJWT, exportJWK, generateKeyPair } from 'jose'

import { getDb } from '../db/index.ts'
import { createAuth } from '../lib/auth.ts'
import type { Auth } from '../lib/auth.ts'
import { requireAgent } from './require-agent.ts'

const BASE = 'http://agents.test'
const ISSUER = `${BASE}/api/auth`

let auth: Auth
let agentId: string
let hostId: string
let agentKeys: Awaited<ReturnType<typeof generateKeyPair>>

async function freshAgentJwt(): Promise<string> {
  // jti is replay-protected — every request needs a fresh token.
  return new SignJWT({ aud: `${ISSUER}/capability/execute` })
    .setProtectedHeader({ alg: 'EdDSA', typ: 'agent+jwt' })
    .setIssuer(hostId)
    .setSubject(agentId)
    .setIssuedAt()
    .setJti(crypto.randomUUID())
    .setExpirationTime('2m')
    .sign(agentKeys.privateKey)
}

const protectedRequest = (headers: Record<string, string> = {}) =>
  new Request(`${BASE}/v1/agents/me`, { headers })

beforeAll(async () => {
  auth = createAuth(getDb(env), {
    secret: 'vitest-only-better-auth-secret-0123456789',
    baseUrl: BASE,
  })

  const hostKeys = await generateKeyPair('Ed25519', { extractable: true })
  agentKeys = await generateKeyPair('Ed25519', { extractable: true })
  hostId = crypto.randomUUID()

  const hostJwt = await new SignJWT({
    aud: ISSUER,
    host_public_key: await exportJWK(hostKeys.publicKey),
    agent_public_key: await exportJWK(agentKeys.publicKey),
  })
    .setProtectedHeader({ alg: 'EdDSA', typ: 'host+jwt' })
    .setIssuer(hostId)
    .setIssuedAt()
    .setJti(crypto.randomUUID())
    .setExpirationTime('5m')
    .sign(hostKeys.privateKey)

  const response = await auth.handler(
    new Request(`${ISSUER}/agent/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${hostJwt}`,
      },
      body: JSON.stringify({
        name: 'require-agent-test',
        mode: 'autonomous',
        capabilities: ['getSchema'],
      }),
    }),
  )
  expect(response.ok).toBe(true)
  const registration = (await response.json()) as {
    agent_id?: string
    host_id?: string
    status?: string
  }
  expect(registration.status).toBe('active')
  agentId = registration.agent_id ?? ''
  hostId = registration.host_id ?? hostId
  expect(agentId).not.toBe('')
})

describe('requireAgent', () => {
  it('authenticates a valid agent JWT (200 path)', async () => {
    const result = await requireAgent(
      auth,
      protectedRequest({ authorization: `Bearer ${await freshAgentJwt()}` }),
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.principal.agentId).toBe(agentId)
      expect(result.principal.mode).toBe('autonomous')
      expect(result.principal.capabilities).toContain('getSchema')
    }
  })

  it('rejects requests without a JWT (401)', async () => {
    const result = await requireAgent(auth, protectedRequest())
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.response.status).toBe(401)
      const body = (await result.response.json()) as {
        error: { code: string }
      }
      expect(body.error.code).toBe('unauthorized')
    }
  })

  it('rejects garbage JWTs (401)', async () => {
    const result = await requireAgent(
      auth,
      protectedRequest({ authorization: 'Bearer not.a.jwt' }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.response.status).toBe(401)
  })

  it('enforces capability grants (403)', async () => {
    const result = await requireAgent(
      auth,
      protectedRequest({ authorization: `Bearer ${await freshAgentJwt()}` }),
      { capability: 'manage_subscriptions' },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.response.status).toBe(403)
      const body = (await result.response.json()) as {
        error: { code: string }
      }
      expect(body.error.code).toBe('capability_not_granted')
    }
  })
})
