import { beforeAll, describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'

import { getDb } from '../db/index.ts'
import type { Db } from '../db/index.ts'
import { endpoints, models, providers, schemaVersions } from '../db/schema.ts'
import { handleMcpRequest } from './mcp.ts'

const NOW = 1_781_150_000
const SCHEMA = {
  type: 'object',
  required: ['model'],
  properties: { model: { type: 'string' } },
}
let db: Db

function rpc(method: string, params?: Record<string, unknown>, id = 1) {
  return new Request('http://mcp.test/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  })
}

interface ToolCallResult {
  result: { content: Array<{ text: string }>; isError: boolean }
}

async function callTool(name: string, args: Record<string, unknown>) {
  const response = await handleMcpRequest(
    db,
    rpc('tools/call', { name, arguments: args }),
  )
  const body = (await response.json()) as ToolCallResult
  return {
    isError: body.result.isError,
    data: JSON.parse(body.result.content[0]?.text ?? 'null') as unknown,
  }
}

beforeAll(async () => {
  db = getDb(env)
  await db.insert(providers).values({
    id: 'mcp-prov',
    displayName: 'MCP Prov',
    specSourceUrl: 'https://example.com/spec.json',
  })
  await db.insert(models).values({
    id: 'mcp-prov-modelzilla',
    providerId: 'mcp-prov',
    rawId: 'modelzilla',
    activity: 'chat',
    displayName: 'Modelzilla',
    firstSeenAt: NOW,
    lastSeenAt: NOW,
  })
  await db.insert(endpoints).values({
    id: 'mcp-prov/v1/messages',
    providerId: 'mcp-prov',
    activity: 'chat',
    method: 'POST',
    path: '/v1/messages',
  })
  await db.insert(schemaVersions).values({
    id: 'mcp-prov/v1/messages:input:1',
    endpointId: 'mcp-prov/v1/messages',
    kind: 'input',
    contentHash: 'c'.repeat(64),
    schema: JSON.stringify(SCHEMA),
    createdAt: NOW,
  })
})

describe('MCP endpoint', () => {
  it('initializes and lists the five tools', async () => {
    const init = await handleMcpRequest(db, rpc('initialize'))
    const initBody = (await init.json()) as {
      result: { protocolVersion: string; serverInfo: { name: string } }
    }
    expect(initBody.result.serverInfo.name).toBe('modelschemas')
    expect(initBody.result.protocolVersion).toBeTruthy()

    const list = await handleMcpRequest(db, rpc('tools/list'))
    const listBody = (await list.json()) as {
      result: { tools: Array<{ name: string }> }
    }
    expect(listBody.result.tools.map((t) => t.name).sort()).toEqual([
      'get_model',
      'get_schema',
      'list_models',
      'recent_changes',
      'validate_payload',
    ])
  })

  it('round-trips get_schema', async () => {
    const { isError, data } = await callTool('get_schema', {
      provider: 'mcp-prov',
      activity: 'chat',
      endpointId: 'v1/messages',
    })
    expect(isError).toBe(false)
    const schema = data as { contentHash: string; schema: unknown }
    expect(schema.contentHash).toBe('c'.repeat(64))
    expect(schema.schema).toEqual(SCHEMA)
  })

  it('serves list_models / get_model / validate_payload / recent_changes', async () => {
    const listed = await callTool('list_models', { provider: 'mcp-prov' })
    expect(
      (listed.data as { models: Array<{ id: string }> }).models.map(
        (m) => m.id,
      ),
    ).toContain('mcp-prov-modelzilla')

    const model = await callTool('get_model', {
      provider: 'mcp-prov',
      modelId: 'modelzilla',
    })
    expect((model.data as { displayName: string }).displayName).toBe(
      'Modelzilla',
    )

    const valid = await callTool('validate_payload', {
      provider: 'mcp-prov',
      endpointId: 'v1/messages',
      payload: { model: 'modelzilla' },
    })
    expect((valid.data as { valid: boolean }).valid).toBe(true)

    const invalid = await callTool('validate_payload', {
      provider: 'mcp-prov',
      endpointId: 'v1/messages',
      payload: {},
    })
    expect((invalid.data as { valid: boolean }).valid).toBe(false)

    const changes = await callTool('recent_changes', { provider: 'mcp-prov' })
    expect(changes.isError).toBe(false)
  })

  it('handles errors per protocol', async () => {
    const unknownTool = await callTool('frobnicate', {})
    expect(unknownTool.isError).toBe(true)

    const missingSchema = await callTool('get_schema', {
      provider: 'mcp-prov',
      activity: 'image',
      endpointId: 'nope',
    })
    expect(missingSchema.isError).toBe(true)

    const badMethod = await handleMcpRequest(db, rpc('resources/list'))
    const body = (await badMethod.json()) as { error: { code: number } }
    expect(body.error.code).toBe(-32601)

    const notification = await handleMcpRequest(
      db,
      rpc('notifications/initialized'),
    )
    expect(notification.status).toBe(202)

    const get = await handleMcpRequest(
      db,
      new Request('http://mcp.test/mcp', { method: 'GET' }),
    )
    expect(get.status).toBe(405)
  })
})
