import type { ProbeRecord } from './types.ts'

/**
 * OpenCode Go Gemini routes probed 2026-10-23 (issue #461).
 *
 * go.mdx lists only the base
 * `…/models/gemini-4-argon-contributor`, with no method. These two calls
 * returned 200 with a Gemini-shaped body (`candidates`, `usageMetadata`;
 * the non-stream body also had `thoughtSignature`). That is enough to bind
 * the route. It is not a published statement that Google's request schema
 * is this API, so the synced operations stay route-only.
 *
 * Before the workspace allowed training, `:generateContent` returned 400
 * "This Go model trains on request data…". That statement is
 * `trainsOnRequestData` on this model only.
 *
 * `authorization` is the env name, never a key.
 */
const HEADERS = {
  authorization: 'Bearer $OPENCODE_GO_API_KEY',
  'content-type': 'application/json',
  'user-agent': 'modelschemas-probe/1',
  'x-opencode-session': 'modelschemas-probe',
}

const BODY = {
  contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
  generationConfig: { maxOutputTokens: 8 },
}

const MODEL = 'gemini-4-argon-contributor'
const BASE = `inference/go/google/v1beta/models/${MODEL}`

export const OPENCODE_GO_PROBE_SOURCE =
  'src/server/providers/probes/opencode-go.ts'

export const records: Array<ProbeRecord> = [
  {
    id: 'gemini-4-argon-contributor-generate',
    provider: 'opencode-go',
    model: MODEL,
    fact: 'schemaEndpointId',
    route: `${BASE}:generateContent`,
    verifiedAt: '2026-10-23',
    ranBy: 'tombeckenham',
    request: {
      method: 'POST',
      path: `/${BASE}:generateContent`,
      headers: HEADERS,
      body: BODY,
    },
    expect: {
      status: 200,
      jsonKeys: ['candidates', 'usageMetadata'],
    },
    trainsOnRequestData: true,
  },
  {
    id: 'gemini-4-argon-contributor-stream',
    provider: 'opencode-go',
    model: MODEL,
    fact: 'schemaEndpointId',
    route: `${BASE}:streamGenerateContent`,
    verifiedAt: '2026-10-23',
    ranBy: 'tombeckenham',
    request: {
      method: 'POST',
      path: `/${BASE}:streamGenerateContent?alt=sse`,
      headers: HEADERS,
      body: BODY,
    },
    expect: {
      status: 200,
      jsonKeys: ['candidates'],
      sse: true,
    },
  },
]
