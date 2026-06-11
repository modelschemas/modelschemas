/**
 * API-key fallback registration (PLAN.md task 5.3) — for agents that don't
 * speak the agent-auth protocol: one POST creates a Better Auth user and an
 * API key (returned exactly once).
 */
import { eq } from 'drizzle-orm'

import type { Db } from '#/db/index.ts'
import { user } from '#/db/schema.ts'
import type { Auth } from '#/lib/auth.ts'
import { requireAgent } from '#/server/require-agent.ts'
import { AUTHENTICATED_LIMIT, readRateUsage } from '#/server/rate-limit.ts'

export interface RegisterKeyBody {
  name: string
  email?: string
}

export function parseRegisterKeyBody(raw: unknown): RegisterKeyBody | null {
  if (typeof raw !== 'object' || raw === null) return null
  const body = raw as Record<string, unknown>
  if (typeof body.name !== 'string' || body.name.trim() === '') return null
  if (body.email !== undefined && typeof body.email !== 'string') return null
  return { name: body.name.trim(), email: body.email }
}

export type RegisterKeyOutcome =
  | {
      ok: true
      result: {
        key: string
        keyId: string
        userId: string
        name: string
        note: string
      }
    }
  | { ok: false; status: number; code: string; message: string }

export async function registerKeyAgent(
  auth: Auth,
  db: Db,
  body: RegisterKeyBody,
): Promise<RegisterKeyOutcome> {
  const slug = body.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  const email =
    body.email ??
    `${slug || 'agent'}-${crypto.randomUUID().slice(0, 8)}@agents.modelschemas.invalid`

  // Pre-check the email: better-auth's sign-up throw leaves a floating
  // rejection in its dispatch layer, so refuse duplicates before calling it.
  const existing = await db.query.user.findFirst({
    where: eq(user.email, email),
    columns: { id: true },
  })
  if (existing) {
    return {
      ok: false,
      status: 409,
      code: 'email_taken',
      message: `An account already exists for '${email}'.`,
    }
  }

  // Random throwaway password: this account authenticates via API key only.
  const password = crypto.randomUUID() + crypto.randomUUID()

  let userId: string
  try {
    const signUp = await auth.api.signUpEmail({
      body: { name: body.name, email, password },
    })
    userId = signUp.user.id
  } catch (error) {
    return {
      ok: false,
      status: 409,
      code: 'registration_failed',
      message:
        error instanceof Error
          ? `Could not create account: ${error.message}`
          : 'Could not create account.',
    }
  }

  const created = await auth.api.createApiKey({
    body: { name: `${body.name} key`, userId },
  })

  return {
    ok: true,
    result: {
      key: created.key,
      keyId: created.id,
      userId,
      name: body.name,
      note: 'Store this key now — it is shown exactly once. Send it as Authorization: Bearer <key>.',
    },
  }
}

/** GET /v1/agents/me (task 5.5): identity, grants, limits, current usage. */
export async function agentsMe(
  auth: Auth,
  kv: KVNamespace,
  request: Request,
): Promise<Response> {
  const result = await requireAgent(auth, request)
  if (!result.ok) return result.response

  const principal = result.principal
  const bucket =
    principal.kind === 'agent'
      ? `agent:${principal.agentId}`
      : `key:${principal.keyId}`
  const usage = await readRateUsage(
    kv,
    bucket,
    AUTHENTICATED_LIMIT.limit,
    AUTHENTICATED_LIMIT.windowSeconds,
  )

  return Response.json({
    agent: principal,
    grants: principal.capabilities,
    limits: {
      requestsPerHour: AUTHENTICATED_LIMIT.limit,
      anonymousRequestsPerHour: 60,
    },
    usage,
    _links: {
      self: '/v1/agents/me',
      capabilities: '/api/auth/capability/list',
      changes: '/v1/changes',
      subscriptions: '/v1/subscriptions',
    },
  })
}
