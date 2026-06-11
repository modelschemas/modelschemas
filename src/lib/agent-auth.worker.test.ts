import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'

import { getDb } from '../db/index.ts'
import { createAuth } from './auth.ts'

const TEST_SECRET = 'vitest-only-better-auth-secret-0123456789'

function makeAuth() {
  return createAuth(getDb(env), {
    secret: TEST_SECRET,
    baseUrl: 'http://test.local',
  })
}

describe('agent-auth provider surface', () => {
  it('serves the discovery document with our provider identity and modes', async () => {
    const config = (await makeAuth().api.getAgentConfiguration()) as {
      provider_name: string
      modes: Array<string>
      endpoints: Record<string, string>
      default_location: string
    }
    expect(config.provider_name).toBe('modelschemas')
    expect(config.modes).toEqual(
      expect.arrayContaining(['autonomous', 'delegated']),
    )
    expect(config.endpoints.register).toBe(
      'http://test.local/api/auth/agent/register',
    )
    expect(config.default_location).toBe(
      'http://test.local/api/auth/capability/execute',
    )
  })

  it('lists capabilities derived from openapi.json plus manage_subscriptions, minus admin', async () => {
    const listed = (await makeAuth().api.listCapabilities()) as {
      capabilities: Array<{ name: string; approval_strength?: string }>
    }
    const names = listed.capabilities.map((c) => c.name)
    for (const expected of [
      'getSchema',
      'listModels',
      'getModel',
      'listProviders',
      'listProviderSchemas',
      'getActivitySchemas',
      'validatePayload',
      'listChanges',
      'getStatus',
      'manage_subscriptions',
    ]) {
      expect(names).toContain(expected)
    }
    expect(names).not.toContain('syncProvider')

    // Read/validate capabilities are approval-free for autonomous agents.
    const getSchema = listed.capabilities.find((c) => c.name === 'getSchema')
    expect(getSchema?.approval_strength).toBe('none')
  })
})
