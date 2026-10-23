/**
 * Facts OpenCode publishes for every Go request, plus a training opt-in
 * only where a probe record states it for that exact id (issue #461).
 */
import type { FactSource, ModelFactSources } from './types.ts'
import { probesFor } from './probes/index.ts'

/** https://opencode.ai/docs/go/ "Where can I use it?" */
export const OPENCODE_GO_DOCS_URL = 'https://opencode.ai/docs/go/'

export interface RequiredRequestHeader {
  name: string
  /** What the client must send. No constant: the client chooses the value. */
  description: string
}

export const OPENCODE_GO_REQUIRED_HEADERS: Array<RequiredRequestHeader> = [
  {
    name: 'x-opencode-session',
    description:
      'A stable session id the client chooses. Go rejects a request that omits it.',
  },
  {
    name: 'User-Agent',
    description: 'A client-specific User-Agent.',
  },
]

/** OpenAPI header parameters for every Go operation. Values are not constants. */
export function openCodeGoHeaderParameters(): Array<Record<string, unknown>> {
  return OPENCODE_GO_REQUIRED_HEADERS.map((header) => ({
    name: header.name,
    in: 'header',
    required: true,
    description: `${header.description} ${OPENCODE_GO_DOCS_URL}`,
    schema: { type: 'string' },
  }))
}

const HEADER_SOURCE: FactSource = {
  derivation: 'docs-derived',
  sourceUrl: OPENCODE_GO_DOCS_URL,
  path: 'Where can I use it?',
}

export function openCodeGoFacts(
  providerId: string,
  rawId: string,
): {
  requiredRequestHeaders: Array<RequiredRequestHeader> | null
  trainsOnRequestData: boolean | null
  factSources: Pick<
    ModelFactSources,
    'requiredRequestHeaders' | 'trainsOnRequestData'
  >
} {
  if (providerId !== 'opencode-go') {
    return {
      requiredRequestHeaders: null,
      trainsOnRequestData: null,
      factSources: {},
    }
  }
  const training = probesFor(providerId).find(
    (record) => record.model === rawId && record.trainsOnRequestData === true,
  )
  return {
    requiredRequestHeaders: OPENCODE_GO_REQUIRED_HEADERS,
    trainsOnRequestData: training ? true : null,
    factSources: {
      requiredRequestHeaders: HEADER_SOURCE,
      ...(training
        ? {
            trainsOnRequestData: {
              derivation: 'probe-verified' as const,
              verifiedAt: training.verifiedAt,
              sourceUrl: `src/server/providers/probes/opencode-go.ts#${training.id}`,
            },
          }
        : {}),
    },
  }
}
