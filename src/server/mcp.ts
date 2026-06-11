/**
 * MCP server endpoint (PLAN.md task 7.1) — stateless streamable-HTTP:
 * every request is a self-contained JSON-RPC POST answered with JSON (no
 * SSE session state to hold on Workers). Tools reuse the Phase 4 service
 * functions directly.
 */
import type { Db } from '#/db/index.ts'
import { activities, changeTypes } from '#/db/schema.ts'
import type { Activity, ChangeType } from '#/db/schema.ts'
import { listChanges } from '#/server/changes-api.ts'
import { getModelDetail, listModelsCatalog } from '#/server/catalog.ts'
import { getEndpointSchema } from '#/server/schemas-api.ts'
import { validatePayload } from '#/server/validate.ts'

export const MCP_PROTOCOL_VERSION = '2025-03-26'

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: number | string | null
  method: string
  params?: Record<string, unknown>
}

interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

const TOOLS: Array<ToolDefinition> = [
  {
    name: 'list_models',
    description:
      'Cross-provider model catalog: which AI models exist right now, filterable by activity (chat/image/video/audio/embeddings/moderation), provider, capability substring, or free text.',
    inputSchema: {
      type: 'object',
      properties: {
        activity: { type: 'string', enum: [...activities] },
        provider: { type: 'string' },
        capability: { type: 'string' },
        q: { type: 'string' },
      },
    },
  },
  {
    name: 'get_model',
    description:
      'Full metadata for one model (context window, modalities, pricing, capabilities). Accepts the model slug or raw provider id.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string' },
        modelId: { type: 'string' },
      },
      required: ['provider', 'modelId'],
    },
  },
  {
    name: 'get_schema',
    description:
      'Self-contained JSON Schema ($defs-bundled) for a provider endpoint — request (input) or response (output) shape.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string' },
        activity: { type: 'string', enum: [...activities] },
        endpointId: {
          type: 'string',
          description:
            "Path-derived id, e.g. 'v1/messages' or 'chat/completions'.",
        },
        kind: { type: 'string', enum: ['input', 'output'] },
        version: {
          type: 'string',
          description: 'Content hash of a historical version.',
        },
      },
      required: ['provider', 'activity', 'endpointId'],
    },
  },
  {
    name: 'validate_payload',
    description:
      'Validate a request/response payload against the current stored schema for a provider endpoint before spending tokens on a real call.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string' },
        endpointId: { type: 'string' },
        kind: { type: 'string', enum: ['input', 'output'] },
        payload: { description: 'The payload to validate.' },
      },
      required: ['provider', 'endpointId', 'payload'],
    },
  },
  {
    name: 'recent_changes',
    description:
      'Changelog feed of model/schema/endpoint changes (cursor-paginated, newest first).',
    inputSchema: {
      type: 'object',
      properties: {
        since: {
          type: 'integer',
          description: 'Unix epoch seconds lower bound.',
        },
        provider: { type: 'string' },
        type: { type: 'string', enum: [...changeTypes] },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
        cursor: { type: 'string' },
      },
    },
  },
]

function rpcResult(id: JsonRpcRequest['id'], result: unknown) {
  return { jsonrpc: '2.0' as const, id: id ?? null, result }
}

function rpcError(id: JsonRpcRequest['id'], code: number, message: string) {
  return { jsonrpc: '2.0' as const, id: id ?? null, error: { code, message } }
}

function toolText(value: unknown, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 1) }],
    isError,
  }
}

async function callTool(
  db: Db,
  name: string,
  args: Record<string, unknown>,
): Promise<ReturnType<typeof toolText>> {
  switch (name) {
    case 'list_models': {
      const result = await listModelsCatalog(db, {
        activity: args.activity as Activity | undefined,
        provider: args.provider as string | undefined,
        capability: args.capability as string | undefined,
        q: args.q as string | undefined,
      })
      return toolText(result)
    }
    case 'get_model': {
      const model = await getModelDetail(
        db,
        String(args.provider ?? ''),
        String(args.modelId ?? ''),
      )
      if (!model) {
        return toolText(
          {
            error: 'unknown_model',
            hint: 'Use list_models to find valid ids.',
          },
          true,
        )
      }
      return toolText(model)
    }
    case 'get_schema': {
      const kind = args.kind === 'output' ? 'output' : 'input'
      const schema = await getEndpointSchema(
        db,
        String(args.provider ?? ''),
        args.activity as Activity,
        String(args.endpointId ?? ''),
        kind,
        args.version as string | undefined,
      )
      if (!schema) {
        return toolText(
          {
            error: 'unknown_schema',
            hint: 'Check provider/activity/endpointId; list endpoints via the schema index at /v1/schemas/{provider}.',
          },
          true,
        )
      }
      return toolText(schema)
    }
    case 'validate_payload': {
      const outcome = await validatePayload(db, {
        provider: String(args.provider ?? ''),
        endpointId: String(args.endpointId ?? ''),
        kind: args.kind === 'output' ? 'output' : undefined,
        payload: args.payload,
      })
      if (!outcome.ok) {
        return toolText({ error: outcome.code, message: outcome.message }, true)
      }
      return toolText(outcome.result)
    }
    case 'recent_changes': {
      const outcome = await listChanges(db, {
        since: args.since as number | undefined,
        provider: args.provider as string | undefined,
        type: args.type as ChangeType | undefined,
        limit: args.limit as number | undefined,
        cursor: args.cursor as string | undefined,
      })
      if (!outcome.ok) {
        return toolText({ error: outcome.code, message: outcome.message }, true)
      }
      return toolText(outcome.result)
    }
    default:
      return toolText(
        {
          error: 'unknown_tool',
          message: `Unknown tool '${name}'. Available: ${TOOLS.map((t) => t.name).join(', ')}.`,
        },
        true,
      )
  }
}

/** Handle one MCP request (POST /mcp). */
export async function handleMcpRequest(
  db: Db,
  request: Request,
): Promise<Response> {
  if (request.method === 'GET') {
    // Stateless server: no SSE stream to subscribe to.
    return new Response(null, { status: 405, headers: { Allow: 'POST' } })
  }
  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { Allow: 'POST' } })
  }

  let rpc: JsonRpcRequest
  try {
    rpc = (await request.json()) as JsonRpcRequest
  } catch {
    return Response.json(rpcError(null, -32700, 'Parse error'), { status: 400 })
  }

  // Notifications get a body-less 202 per streamable HTTP.
  if (rpc.method.startsWith('notifications/')) {
    return new Response(null, { status: 202 })
  }

  switch (rpc.method) {
    case 'initialize':
      return Response.json(
        rpcResult(rpc.id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: {
            name: 'modelschemas',
            version: '0.1.0',
            description:
              'Live AI model schemas: catalog, JSON Schemas, validation, change feed.',
          },
        }),
      )
    case 'ping':
      return Response.json(rpcResult(rpc.id, {}))
    case 'tools/list':
      return Response.json(rpcResult(rpc.id, { tools: TOOLS }))
    case 'tools/call': {
      const name = String(rpc.params?.name ?? '')
      const args = (rpc.params?.arguments ?? {}) as Record<string, unknown>
      return Response.json(rpcResult(rpc.id, await callTool(db, name, args)))
    }
    default:
      return Response.json(
        rpcError(rpc.id, -32601, `Method not found: ${rpc.method}`),
      )
  }
}
