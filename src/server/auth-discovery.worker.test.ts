import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'
import { SignJWT, exportJWK, generateKeyPair } from 'jose'

import { getDb } from '../db/index.ts'
import { createAuth, publicCapabilityNames } from '../lib/auth.ts'
import {
  authMd,
  oauthAuthorizationServer,
  oauthProtectedResource,
} from './auth-discovery.ts'

const BASE = 'http://agents.test'

describe('auth discovery (task 10.4)', () => {
  it('protected-resource metadata exposes real scopes and docs', () => {
    const doc = oauthProtectedResource(BASE) as {
      resource: string
      authorization_servers: Array<string>
      scopes_supported: Array<string>
      resource_documentation: string
    }
    expect(doc.resource).toBe(BASE)
    expect(doc.authorization_servers).toEqual([BASE])
    expect(doc.scopes_supported).toEqual(publicCapabilityNames())
    expect(doc.scopes_supported.length).toBeGreaterThan(0)
    expect(doc.resource_documentation).toBe(`${BASE}/auth.md`)
  })

  it('authorization-server metadata is honest — no fake OAuth endpoints', () => {
    const doc = oauthAuthorizationServer(BASE)
    expect(doc.issuer).toBe(`${BASE}/api/auth`)
    expect(doc.authorization_endpoint).toBeUndefined()
    expect(doc.token_endpoint).toBeUndefined()
    expect(doc.grant_types_supported).toEqual([])
  })

  it('auth.md documents both registration paths and every scope', () => {
    const md = authMd(BASE)
    expect(md).toContain('/v1/agents/register-key')
    expect(md).toContain(`${BASE}/api/auth/agent/register`)
    expect(md).toContain('.well-known/agent-configuration')
    for (const name of publicCapabilityNames()) {
      expect(md).toContain(`\`${name}\``)
    }
  })

  it('agent_auth.register_uri round-trips against the live register endpoint', async () => {
    const auth = createAuth(getDb(env), {
      secret: 'vitest-only-better-auth-secret-0123456789',
      baseUrl: BASE,
    })
    const doc = oauthAuthorizationServer(BASE) as {
      agent_auth: { register_uri: string }
    }
    const registerUri = doc.agent_auth.register_uri
    expect(registerUri).toBe(`${BASE}/api/auth/agent/register`)

    const hostKeys = await generateKeyPair('Ed25519', { extractable: true })
    const agentKeys = await generateKeyPair('Ed25519', { extractable: true })
    const hostId = crypto.randomUUID()
    const hostJwt = await new SignJWT({
      aud: `${BASE}/api/auth`,
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
      new Request(registerUri, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${hostJwt}`,
        },
        body: JSON.stringify({
          name: 'auth-discovery-test',
          mode: 'autonomous',
          capabilities: ['getSchema'],
        }),
      }),
    )
    expect(response.ok).toBe(true)
    const registration = (await response.json()) as { status?: string }
    expect(registration.status).toBe('active')
  })
})
