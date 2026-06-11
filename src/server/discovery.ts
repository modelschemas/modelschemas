/**
 * Agent-discovery documents (PLAN.md task 10.3): the RFC 9727 api-catalog
 * linkset, the SEP-1649 MCP server card, and the Agent Skills Discovery
 * index. All derive from the same sources as the surfaces they point at
 * (openapi.json version, MCP TOOLS, live SKILL.md) so they can't drift.
 */
import { TOOLS } from '#/server/mcp.ts'
import { skillMd } from '#/server/skill.ts'

export const LINKSET_CONTENT_TYPE = 'application/linkset+json'

export function apiCatalog(origin: string): Record<string, unknown> {
  return {
    linkset: [
      {
        anchor: `${origin}/v1`,
        'service-desc': [
          { href: `${origin}/openapi.json`, type: 'application/json' },
        ],
        'service-doc': [
          { href: `${origin}/docs`, type: 'text/html' },
          { href: `${origin}/llms.txt`, type: 'text/markdown' },
        ],
        status: [{ href: `${origin}/v1`, type: 'application/json' }],
      },
    ],
  }
}

export function mcpServerCard(origin: string): Record<string, unknown> {
  return {
    serverInfo: {
      name: 'modelschemas',
      title: 'modelschemas — live AI model schemas',
      version: '0.1.0',
    },
    description:
      'Live AI model schema service: which models exist right now, their ' +
      'metadata, and per-endpoint request/response JSON Schemas for every ' +
      'monitored provider.',
    transport: {
      type: 'streamable-http',
      endpoint: `${origin}/mcp`,
    },
    capabilities: { tools: {} },
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
    })),
    documentation: `${origin}/docs`,
  }
}

function skillDescription(): string {
  const match = /^description: (.+)$/m.exec(skillMd)
  return match?.[1] ?? 'Live AI model schema service.'
}

export async function skillSha256(): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(skillMd),
  )
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

export async function agentSkillsIndex(
  origin: string,
): Promise<Record<string, unknown>> {
  return {
    $schema:
      'https://raw.githubusercontent.com/agent-skills/discovery/v0.2.0/index.schema.json',
    skills: [
      {
        name: 'modelschemas',
        type: 'skill',
        description: skillDescription(),
        url: `${origin}/skill`,
        sha256: await skillSha256(),
      },
    ],
  }
}
