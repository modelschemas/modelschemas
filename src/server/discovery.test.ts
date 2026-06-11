import { describe, expect, it } from 'vitest'

import {
  agentSkillsIndex,
  apiCatalog,
  mcpServerCard,
  skillSha256,
} from './discovery.ts'
import { TOOLS } from './mcp.ts'
import { skillMd } from './skill.ts'

const ORIGIN = 'https://modelschemas.com'

describe('discovery trio (task 10.3)', () => {
  it('api-catalog is an RFC 9727 linkset over our surfaces', () => {
    const catalog = apiCatalog(ORIGIN) as {
      linkset: Array<Record<string, unknown>>
    }
    expect(catalog.linkset).toHaveLength(1)
    const entry = catalog.linkset[0]
    expect(entry?.anchor).toBe(`${ORIGIN}/v1`)
    expect(entry?.['service-desc']).toEqual([
      { href: `${ORIGIN}/openapi.json`, type: 'application/json' },
    ])
    expect(JSON.stringify(entry?.['service-doc'])).toContain(`${ORIGIN}/docs`)
  })

  it('mcp server card points at /mcp and mirrors the live tool list', () => {
    const card = mcpServerCard(ORIGIN) as {
      serverInfo: { name: string }
      transport: { type: string; endpoint: string }
      tools: Array<{ name: string }>
    }
    expect(card.serverInfo.name).toBe('modelschemas')
    expect(card.transport).toEqual({
      type: 'streamable-http',
      endpoint: `${ORIGIN}/mcp`,
    })
    expect(card.tools.map((tool) => tool.name)).toEqual(
      TOOLS.map((tool) => tool.name),
    )
  })

  it('agent-skills index sha256 matches the served SKILL.md body', async () => {
    const index = (await agentSkillsIndex(ORIGIN)) as {
      $schema: string
      skills: Array<{
        name: string
        type: string
        description: string
        url: string
        sha256: string
      }>
    }
    expect(index.$schema).toContain('v0.2.0')
    const skill = index.skills[0]
    expect(skill?.name).toBe('modelschemas')
    expect(skill?.url).toBe(`${ORIGIN}/skill`)
    expect(skill?.sha256).toBe(await skillSha256())
    expect(skill?.sha256).toMatch(/^[0-9a-f]{64}$/)
    // The digest is of the exact bytes /skill serves.
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(skillMd),
    )
    const hex = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
    expect(skill?.sha256).toBe(hex)
    expect(skill?.description).toContain('model schema')
  })
})
