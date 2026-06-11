/**
 * Agent JWT verification for our native /v1 routes (PLAN.md task 5.2) — as
 * opposed to the /capability/execute proxy. Wraps the plugin's
 * verifyAgentRequest + a grant check. Task 5.3 extends the accepted
 * credentials with API keys.
 */
import { verifyAgentRequest } from '@better-auth/agent-auth'

import type { Auth } from '#/lib/auth.ts'
import { jsonError } from '#/server/admin.ts'

export interface AgentPrincipal {
  kind: 'agent'
  agentId: string
  name: string
  mode: 'autonomous' | 'delegated'
  userId: string | null
  capabilities: Array<string>
}

interface AgentSessionResponse {
  type: 'autonomous' | 'delegated'
  agent: {
    id: string
    name: string
    mode: 'autonomous' | 'delegated'
    capabilityGrants: Array<{ capability: string; status: string }>
  }
  host: { id: string; userId: string | null } | null
  user: { id: string } | null
}

async function fetchAgentSession(
  auth: Auth,
  request: Request,
): Promise<AgentSessionResponse | null> {
  const viaHelper = (await verifyAgentRequest(
    request,
    auth,
  )) as AgentSessionResponse | null
  if (viaHelper) return viaHelper

  // verifyAgentRequest builds `${options.baseURL}/agent/session`, which
  // misses the basePath when baseURL is a bare origin — retry with it.
  const base = (auth.options.baseURL ?? '').replace(/\/$/, '')
  const basePath = (
    (auth.options as { basePath?: string }).basePath ?? '/api/auth'
  ).replace(/\/$/, '')
  if (!base || !request.headers.get('authorization')) return null
  const response = await auth.handler(
    new Request(`${base}${basePath}/agent/session`, {
      method: 'GET',
      headers: request.headers,
    }),
  )
  if (!response.ok) return null
  try {
    return (await response.json()) as AgentSessionResponse
  } catch {
    return null
  }
}

export type RequireAgentResult =
  | { ok: true; principal: AgentPrincipal }
  | { ok: false; response: Response }

/**
 * Authenticate a request with an agent JWT; optionally require an active
 * grant for a specific capability. Returns a ready-made 401/403 Response on
 * failure.
 */
export async function requireAgent(
  auth: Auth,
  request: Request,
  options?: { capability?: string },
): Promise<RequireAgentResult> {
  const session = await fetchAgentSession(auth, request)
  if (!session?.agent) {
    return {
      ok: false,
      response: jsonError(
        401,
        'unauthorized',
        'Provide an agent JWT (Authorization: Bearer). Register at /.well-known/agent-configuration.',
      ),
    }
  }

  const capabilities = session.agent.capabilityGrants
    .filter((grant) => grant.status === 'active')
    .map((grant) => grant.capability)

  if (options?.capability && !capabilities.includes(options.capability)) {
    return {
      ok: false,
      response: jsonError(
        403,
        'capability_not_granted',
        `This operation requires the '${options.capability}' capability. Request it via /api/auth/agent/request-capability.`,
      ),
    }
  }

  return {
    ok: true,
    principal: {
      kind: 'agent',
      agentId: session.agent.id,
      name: session.agent.name,
      mode: session.agent.mode,
      userId: session.user?.id ?? session.host?.userId ?? null,
      capabilities,
    },
  }
}
