/**
 * Webhook subscriptions CRUD (PLAN.md task 6.1). Authenticated via
 * requireAgent (capability: manage_subscriptions). Secrets are generated
 * server-side and returned exactly once; list responses never echo them.
 */
import { and, count, eq } from 'drizzle-orm'

import type { Db } from '#/db/index.ts'
import { changeTypes, subscriptions, user } from '#/db/schema.ts'
import type { Principal } from '#/server/require-agent.ts'

const MAX_SUBSCRIPTIONS_PER_OWNER = 10

export interface CreateSubscriptionBody {
  url: string
  events: Array<string>
  provider?: string
}

/**
 * SSRF guard for webhook destinations: only public https hosts. Literal
 * loopback/private/link-local addresses and internal-looking names are
 * rejected at registration; delivery additionally refuses to follow
 * redirects. Residual risk (DNS rebinding to edge-internal space) is
 * accepted: Workers fetch has no privileged network position and workerd
 * exposes no resolver to re-check A records at delivery time.
 */
export function isForbiddenWebhookHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === ''
  ) {
    return true
  }
  const bare = host.replace(/^\[|\]$/g, '')
  if (
    bare === '::' ||
    bare === '::1' ||
    bare.startsWith('fe80:') ||
    bare.startsWith('fc') ||
    bare.startsWith('fd')
  ) {
    return true
  }
  const ipv4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(bare)
  if (ipv4) {
    const a = Number(ipv4[1])
    const b = Number(ipv4[2])
    if (a === 0 || a === 127 || a === 10) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
  }
  return false
}

export function parseCreateSubscriptionBody(
  raw: unknown,
): CreateSubscriptionBody | null {
  if (typeof raw !== 'object' || raw === null) return null
  const body = raw as Record<string, unknown>
  if (typeof body.url !== 'string') return null
  let parsed: URL
  try {
    parsed = new URL(body.url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:') return null
  if (isForbiddenWebhookHost(parsed.hostname)) return null
  if (
    !Array.isArray(body.events) ||
    body.events.length === 0 ||
    !body.events.every(
      (event) =>
        typeof event === 'string' &&
        (changeTypes as ReadonlyArray<string>).includes(event),
    )
  ) {
    return null
  }
  if (body.provider !== undefined && typeof body.provider !== 'string') {
    return null
  }
  return {
    url: body.url,
    events: body.events as Array<string>,
    provider: body.provider,
  }
}

/**
 * The subscriptions.agent_id column FKs user.id. Autonomous agents run
 * under a virtual identity that has no user row — materialise it on first
 * write so FK integrity holds.
 */
async function ensureOwnerUser(db: Db, principal: Principal): Promise<string> {
  const ownerId =
    principal.kind === 'api-key'
      ? principal.userId
      : (principal.userId ?? `agent:${principal.agentId}`)
  const existing = await db.query.user.findFirst({
    where: eq(user.id, ownerId),
    columns: { id: true },
  })
  if (!existing) {
    const now = new Date()
    await db.insert(user).values({
      id: ownerId,
      name: principal.name ?? 'autonomous-agent',
      email: `${ownerId.replace(/[^a-zA-Z0-9]+/g, '-')}@agents.modelschemas.invalid`,
      createdAt: now,
      updatedAt: now,
    })
  }
  return ownerId
}

function generateSecret(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return `whsec_${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`
}

type SubscriptionRow = typeof subscriptions.$inferSelect

function toApiSubscription(row: SubscriptionRow) {
  return {
    id: row.id,
    url: row.url,
    events: row.events,
    provider: row.providerFilter,
    active: row.active,
    createdAt: row.createdAt,
  }
}

export type SubscriptionsOutcome<T> =
  | { ok: true; result: T }
  | { ok: false; status: number; code: string; message: string }

export async function createSubscription(
  db: Db,
  principal: Principal,
  body: CreateSubscriptionBody,
  now = Math.floor(Date.now() / 1000),
): Promise<
  SubscriptionsOutcome<
    ReturnType<typeof toApiSubscription> & { secret: string }
  >
> {
  if (body.provider) {
    const provider = await db.query.providers.findFirst({
      where: (providers, { eq: equals }) =>
        equals(providers.id, body.provider ?? ''),
      columns: { id: true },
    })
    if (!provider) {
      return {
        ok: false,
        status: 404,
        code: 'unknown_provider',
        message: `Unknown provider '${body.provider}'. See GET /v1/providers.`,
      }
    }
  }

  const ownerId = await ensureOwnerUser(db, principal)
  const countRows = await db
    .select({ n: count() })
    .from(subscriptions)
    .where(eq(subscriptions.agentId, ownerId))
  const existing = countRows[0]?.n ?? 0
  if (existing >= MAX_SUBSCRIPTIONS_PER_OWNER) {
    return {
      ok: false,
      status: 409,
      code: 'subscription_limit',
      message: `Limit of ${String(MAX_SUBSCRIPTIONS_PER_OWNER)} subscriptions reached. Delete one first (GET /v1/subscriptions).`,
    }
  }

  const secret = generateSecret()
  const row: typeof subscriptions.$inferInsert = {
    id: crypto.randomUUID(),
    agentId: ownerId,
    url: body.url,
    secret,
    events: body.events,
    providerFilter: body.provider ?? null,
    active: true,
    createdAt: now,
  }
  await db.insert(subscriptions).values(row)
  return {
    ok: true,
    result: {
      ...toApiSubscription({ ...row, active: true } as SubscriptionRow),
      secret,
    },
  }
}

export async function listSubscriptions(db: Db, principal: Principal) {
  const ownerId =
    principal.kind === 'api-key'
      ? principal.userId
      : (principal.userId ?? `agent:${principal.agentId}`)
  const rows = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.agentId, ownerId))
    .orderBy(subscriptions.createdAt)
  return {
    count: rows.length,
    subscriptions: rows.map(toApiSubscription),
    _links: { self: '/v1/subscriptions', changes: '/v1/changes' },
  }
}

export async function deleteSubscription(
  db: Db,
  principal: Principal,
  id: string,
): Promise<SubscriptionsOutcome<{ deleted: string }>> {
  const ownerId =
    principal.kind === 'api-key'
      ? principal.userId
      : (principal.userId ?? `agent:${principal.agentId}`)
  const existing = await db.query.subscriptions.findFirst({
    where: and(eq(subscriptions.id, id), eq(subscriptions.agentId, ownerId)),
    columns: { id: true },
  })
  if (!existing) {
    return {
      ok: false,
      status: 404,
      code: 'unknown_subscription',
      message: `No subscription '${id}' for this account. List yours at GET /v1/subscriptions.`,
    }
  }
  await db.delete(subscriptions).where(eq(subscriptions.id, id))
  return { ok: true, result: { deleted: id } }
}
