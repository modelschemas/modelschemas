/**
 * Agent JWT verification for our native /v1 routes (PLAN.md task 5.2) — as
 * opposed to the /capability/execute proxy. Wraps the plugin's
 * verifyAgentRequest + a grant check. Task 5.3 extends the accepted
 * credentials with API keys.
 */
import { verifyAgentRequest } from '@better-auth/agent-auth'

import { publicCapabilityNames } from '#/lib/auth.ts'
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

/** Authenticated via the api-key fallback (task 5.3) — public capabilities only. */
export interface ApiKeyPrincipal {
  kind: 'api-key'
  keyId: string
  name: string | null
  userId: string
  capabilities: Array<string>
}

export type Principal = AgentPrincipal | ApiKeyPrincipal

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
  | { ok: true; principal: Principal }
  | { ok: false; response: Response }

/** Bearer credentials that are not three-part JWTs are treated as API keys. */
function bearerApiKey(request: Request): string | null {
  const header = request.headers.get('authorization')
  const bearer = header?.startsWith('Bearer ')
    ? header.slice('Bearer '.length)
    : null
  const candidate = request.headers.get('x-api-key') ?? bearer
  if (!candidate || candidate.split('.').length === 3) return null
  return candidate
}

async function verifyApiKeyPrincipal(
  auth: Auth,
  key: string,
): Promise<ApiKeyPrincipal | null> {
  const verified = await auth.api.verifyApiKey({ body: { key } })
  if (!verified.valid || !verified.key) return null
  // The plugin stores the owning user under `referenceId`.
  const owner = verified.key as { id: string; name?: string | null } & {
    referenceId?: string
    userId?: string
  }
  const userId = owner.referenceId ?? owner.userId
  if (!userId) return null
  return {
    kind: 'api-key',
    keyId: owner.id,
    name: owner.name ?? null,
    userId,
    capabilities: publicCapabilityNames(),
  }
}

/**
 * Authenticate a request with an agent JWT or an API key (Bearer or
 * X-Api-Key); optionally require an active grant for a specific capability
 * (API keys pass capability checks — they are the full-access fallback).
 * Returns a ready-made 401/403 Response on failure.
 */
export async function requireAgent(
  auth: Auth,
  request: Request,
  options?: { capability?: string },
): Promise<RequireAgentResult> {
  const apiKey = bearerApiKey(request)
  if (apiKey) {
    const principal = await verifyApiKeyPrincipal(auth, apiKey)
    if (!principal) {
      return {
        ok: false,
        response: jsonError(
          401,
          'invalid_api_key',
          'API key is invalid or disabled. Register a new one at POST /v1/agents/register-key.',
        ),
      }
    }
    // API keys satisfy only public (approval-free) capabilities — privileged
    // capabilities require the agent-auth grant flow.
    if (
      options?.capability &&
      !principal.capabilities.includes(options.capability)
    ) {
      return {
        ok: false,
        response: jsonError(
          403,
          'capability_not_granted',
          `API keys cannot satisfy the '${options.capability}' capability. Use the agent-auth protocol (see /.well-known/agent-configuration).`,
        ),
      }
    }
    return { ok: true, principal }
  }

  const session = await fetchAgentSession(auth, request)
  if (!session?.agent) {
    return {
      ok: false,
      response: jsonError(
        401,
        'unauthorized',
        'Provide an agent JWT or API key (Authorization: Bearer). Register at /.well-known/agent-configuration or POST /v1/agents/register-key.',
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
