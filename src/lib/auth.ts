import { betterAuth } from 'better-auth'
import { bearer, emailOTP } from 'better-auth/plugins'
import { apiKey } from '@better-auth/api-key'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { agentAuth } from '@better-auth/agent-auth'
import { createFromOpenAPI, fromOpenAPI } from '@better-auth/agent-auth/openapi'
import type { BetterAuthPlugin } from 'better-auth'
import type { Capability } from '@better-auth/agent-auth'

import type { Db } from '#/db/index.ts'
import * as schema from '#/db/schema.ts'
import { openApiDocument } from '#/server/openapi.ts'

/** Capabilities never exposed to agents (admin surface). */
const EXCLUDED_CAPABILITIES = new Set(['syncProvider', 'extractFalPricing'])

/**
 * The public (approval-free) capability set. This is also the EXACT set an
 * API-key principal may satisfy: API keys are the low-friction fallback for
 * public operations and must never satisfy a privileged capability — if a
 * capability with approvalStrength !== 'none' is ever added, keep it out of
 * this list (see requireAgent's capability check).
 */
export function publicCapabilityNames(): Array<string> {
  const derived = fromOpenAPI(
    openApiDocument as unknown as Parameters<typeof fromOpenAPI>[0],
  )
    .map((capability) => capability.name)
    .filter((name) => !EXCLUDED_CAPABILITIES.has(name))
  return [...derived, 'manage_subscriptions']
}

export interface CreateAuthOptions {
  secret?: string
  /** Delivers sign-in OTPs (task 9.2). Injectable so tests capture codes;
   * defaults to a structured console line. */
  sendOtp?: (data: { email: string; otp: string }) => Promise<void>
  /** Absolute origin used for capability execution self-calls + JWT audiences. */
  baseUrl?: string
  extraPlugins?: Array<BetterAuthPlugin>
  /** Test hook: fetch used by the capability execute proxy. */
  capabilityFetch?: typeof globalThis.fetch
}

function buildAgentAuthConfig(options?: CreateAuthOptions) {
  const baseUrl = options?.baseUrl ?? 'http://localhost:3000'
  const fromSpec = createFromOpenAPI(
    // `as const` document → readonly arrays; the helper wants mutable.
    openApiDocument as unknown as Parameters<typeof createFromOpenAPI>[0],
    {
      baseUrl,
      fetch: options?.capabilityFetch,
      // Reads + validate are public data: grant without human approval so
      // the autonomous (no-human) path is friction-free.
      approvalStrength: 'none',
    },
  )

  const capabilities: Array<Capability> = [
    ...(fromSpec.capabilities ?? []).filter(
      (capability) => !EXCLUDED_CAPABILITIES.has(capability.name),
    ),
    // Hand-declared: webhook subscription management (Phase 6 endpoints).
    {
      name: 'manage_subscriptions',
      description:
        'Create, list, and delete webhook subscriptions for model/schema change events.',
      approvalStrength: 'none',
      input: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['create', 'list', 'delete'] },
          url: { type: 'string' },
          events: { type: 'array', items: { type: 'string' } },
          provider: { type: 'string' },
          subscriptionId: { type: 'string' },
        },
        required: ['action'],
      },
    },
  ]

  return {
    ...fromSpec,
    providerName: 'modelschemas',
    providerDescription:
      'Live AI model schema service: per-endpoint request/response JSON Schemas and model metadata for monitored providers.',
    // Autonomous (no human in the loop) is the primary path; delegated mode
    // + approvals stay enabled but no current capability requires them.
    modes: ['autonomous', 'delegated'] as Array<'autonomous' | 'delegated'>,
    capabilities,
    // Hosts that register without an explicit capability list get the full
    // public set. Must be the FILTERED list — deriving from the spec would
    // include excluded admin ops (syncProvider, extractFalPricing) and 400 every registration.
    defaultHostCapabilities: capabilities.map((capability) => capability.name),
    // Open agent signup: unknown hosts may self-register with inline keys.
    allowDynamicHostRegistration: true,
    // Autonomous agents have no human owner; execute under a virtual
    // identity (reads are public — this is identity plumbing, not access).
    resolveAutonomousUser: ({
      agentId,
      hostName,
    }: {
      agentId: string
      hostName: string | null
    }) => ({
      id: `agent:${agentId}`,
      name: hostName ?? 'autonomous-agent',
      email: `${agentId}@agents.modelschemas.invalid`,
    }),
  }
}

// Factory rather than a singleton: the D1-backed db only exists per-request
// in Workers. The runtime instance lives in src/server/auth.ts; the better-auth
// CLI loads this factory through scripts/better-auth-config.ts instead, so this
// file must not import `cloudflare:workers` — and must not import
// `better-auth/tanstack-start` either (its vite-resolved subpath imports break
// outside the TanStack build; the runtime passes it via `extraPlugins`).
export function createAuth(db: Db, options?: CreateAuthOptions) {
  return betterAuth({
    database: drizzleAdapter(db, { provider: 'sqlite', schema }),
    secret: options?.secret,
    baseURL: options?.baseUrl,
    // Email/password backs delegated-mode approvals and the later dashboard.
    emailAndPassword: {
      enabled: true,
    },
    plugins: [
      agentAuth(buildAgentAuthConfig(options)),
      apiKey(),
      bearer(),
      // Human sign-in (task 9.2): email OTP, 6 digits, 5-minute expiry.
      emailOTP({
        otpLength: 6,
        expiresIn: 300,
        sendVerificationOTP: async ({ email, otp }) => {
          if (options?.sendOtp) {
            await options.sendOtp({ email, otp })
            return
          }
          console.log(
            JSON.stringify({ job: 'email', mode: 'dev-log', to: email, otp }),
          )
        },
      }),
      ...(options?.extraPlugins ?? []),
    ],
  })
}

export type Auth = ReturnType<typeof createAuth>
