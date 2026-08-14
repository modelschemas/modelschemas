import { afterEach, describe, expect, it, vi } from 'vitest'

import { TOOLS } from '../server/mcp.ts'
import { WEBMCP_TOOLS, registerWebMcp } from './webmcp.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('WebMCP (task 10.6)', () => {
  it('tool definitions are exact copies of the server MCP tools', () => {
    for (const webTool of WEBMCP_TOOLS) {
      const serverTool = TOOLS.find((t) => t.name === webTool.name)
      expect(serverTool, webTool.name).toBeDefined()
      expect(webTool.description).toBe(serverTool?.description)
      expect(webTool.inputSchema).toEqual(serverTool?.inputSchema)
    }
  })

  it('no-ops when navigator.modelContext is absent', () => {
    vi.stubGlobal('navigator', {})
    expect(registerWebMcp()).toBe(false)
  })

  it('registers tools and proxies execute through /mcp JSON-RPC', async () => {
    const provideContext = vi.fn()
    vi.stubGlobal('navigator', { modelContext: { provideContext } })
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { content: [{ type: 'text', text: '{"models":[]}' }] },
        }),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    expect(registerWebMcp()).toBe(true)
    const { tools } = provideContext.mock.calls[0]?.[0] as {
      tools: Array<{
        name: string
        execute: (args: Record<string, unknown>) => Promise<unknown>
      }>
    }
    expect(tools.map((t) => t.name)).toEqual([
      'list_models',
      'list_schemas',
      'get_schema',
      'validate_payload',
    ])

    const result = await tools[0]?.execute({ activity: 'chat' })
    expect(result).toEqual({
      content: [{ type: 'text', text: '{"models":[]}' }],
    })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/mcp')
    expect(JSON.parse(init.body as string)).toMatchObject({
      method: 'tools/call',
      params: { name: 'list_models', arguments: { activity: 'chat' } },
    })
  })
})
