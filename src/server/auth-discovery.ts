/**
 * Auth discovery surfaces (PLAN.md task 10.4): RFC 9728 protected-resource
 * metadata, an RFC 8414 authorization-server document restricted to fields
 * we genuinely implement (agent-auth registration — no classic OAuth flows,
 * so no fake authorize/token endpoints), and /auth.md — markdown
 * registration instructions for agents. All derive scopes from the same
 * capability list the API enforces.
 */
import { publicCapabilityNames } from '#/lib/auth.ts'

export function oauthProtectedResource(
  origin: string,
): Record<string, unknown> {
  return {
    resource: origin,
    authorization_servers: [origin],
    bearer_methods_supported: ['header'],
    scopes_supported: publicCapabilityNames(),
    resource_documentation: `${origin}/auth.md`,
  }
}

export function oauthAuthorizationServer(
  origin: string,
): Record<string, unknown> {
  const issuer = `${origin}/api/auth`
  return {
    issuer,
    registration_endpoint: `${issuer}/agent/register`,
    service_documentation: `${origin}/auth.md`,
    scopes_supported: publicCapabilityNames(),
    // Honest metadata: this server only does agent-auth registration —
    // there is no authorization-code or token endpoint to advertise.
    grant_types_supported: [],
    response_types_supported: [],
    agent_auth: {
      register_uri: `${issuer}/agent/register`,
      configuration: `${origin}/.well-known/agent-configuration`,
      identity_types: ['host+jwt'],
      credential_types: ['Ed25519'],
      token_type: 'agent+jwt',
    },
  }
}

export function authMd(origin: string): string {
  const issuer = `${origin}/api/auth`
  return `# Authenticating with modelschemas

All reads are public at 60 requests/hour per IP — you only need credentials
for higher rate limits (5,000/hour) and webhook subscriptions.

## Option 1 — API key (simplest)

\`\`\`
POST ${origin}/v1/agents/register-key
Content-Type: application/json

{ "name": "my-agent" }
\`\`\`

The response contains your key **once**. Send it on every request:

\`\`\`
Authorization: Bearer <key>
\`\`\`

## Option 2 — agent-auth protocol (Ed25519 JWTs)

Discovery document: \`${origin}/.well-known/agent-configuration\`

1. Generate Ed25519 keypairs for your host and agent.
2. Register: \`POST ${issuer}/agent/register\` with a \`host+jwt\` bearer
   token (iss = your host id, \`host_public_key\` + \`agent_public_key\` as
   JWKs in the claims) and body
   \`{ "name", "mode": "autonomous", "capabilities": [...] }\`.
3. Execute: \`POST ${issuer}/capability/execute\` with a short-lived
   \`agent+jwt\` (iss = host id, sub = agent id, fresh \`jti\` per request —
   tokens are single-use).

Available capabilities (also \`scopes_supported\` in the OAuth metadata):

${publicCapabilityNames()
  .map((name) => `- \`${name}\``)
  .join('\n')}

## Not OAuth

There is no authorization-code or token endpoint —
\`/.well-known/oauth-authorization-server\` advertises registration only.
Human sign-in (email OTP) lives at ${origin}/login.
`
}
