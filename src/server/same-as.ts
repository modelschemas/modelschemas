/** Resolve provider-stated upstream ids to rows in the native catalog. */
import { inArray } from 'drizzle-orm'

import type { Db } from '#/db/index.ts'
import { models } from '#/db/schema.ts'
import type { FactSource } from '#/server/providers/types.ts'
import {
  resolveAlias,
  storedAliases,
} from '#/server/providers/provider-aliases.ts'

export interface SameAs {
  provider: string
  rawId: string
}

export interface ResolvedSameAs {
  target: SameAs
  source: FactSource
}

type ModelIdentity = Pick<
  typeof models.$inferSelect,
  'id' | 'providerId' | 'rawId'
>

interface Candidate {
  provider: string
  rawId: string
  source: FactSource
}

// These prefixes are maker names in the gateways' own model ids. Restricting
// the map avoids treating an open-weight host's namespace as a maker claim.
const MAKER_PREFIXES: Record<string, string> = {
  anthropic: 'anthropic',
  openai: 'openai',
  google: 'gemini',
  xai: 'grok',
  'x-ai': 'grok',
  mistral: 'mistral',
  deepseek: 'deepseek',
  cohere: 'cohere',
}

const GATEWAY_LISTINGS: Record<string, string> = {
  openrouter: 'https://openrouter.ai/api/v1/models',
  vercel: 'https://ai-gateway.vercel.sh/v1/models',
}

function candidate(row: ModelIdentity): Candidate | null {
  if (row.providerId === 'azure') {
    return {
      provider: 'openai',
      rawId: row.rawId,
      source: {
        derivation: 'docs-derived',
        sourceUrl:
          'https://learn.microsoft.com/en-us/azure/ai-services/openai/concepts/models',
        path: 'model id',
      },
    }
  }

  const isGateway =
    row.providerId === 'openrouter' ||
    row.providerId === 'vercel' ||
    row.providerId === 'cloudflare-ai-gateway'
  if (!isGateway) return null

  const slash = row.rawId.indexOf('/')
  if (slash <= 0 || slash === row.rawId.length - 1) return null
  const prefix = row.rawId.slice(0, slash)
  const rawId = row.rawId.slice(slash + 1)
  const provider =
    prefix === 'workers-ai' && row.providerId === 'cloudflare-ai-gateway'
      ? 'cloudflare-workers-ai'
      : MAKER_PREFIXES[prefix]
  if (!provider) return null

  return {
    provider,
    rawId,
    source: {
      derivation:
        row.providerId === 'cloudflare-ai-gateway' ? 'docs-derived' : 'listing',
      sourceUrl:
        GATEWAY_LISTINGS[row.providerId] ??
        'https://developers.cloudflare.com/ai-gateway/',
      path: 'rawId',
    },
  }
}

/** Resolve in one query for a list, and only emit links to existing rows. */
export async function resolveSameAs(
  db: Db,
  rows: readonly ModelIdentity[],
): Promise<Map<string, ResolvedSameAs>> {
  const candidates = rows
    .map((row) => ({ row, match: candidate(row) }))
    .filter(
      (entry): entry is { row: ModelIdentity; match: Candidate } =>
        entry.match !== null,
    )
  if (candidates.length === 0) return new Map()

  const providerIds = [
    ...new Set(candidates.map(({ match }) => match.provider)),
  ]
  const targets = await db
    .select({
      providerId: models.providerId,
      rawId: models.rawId,
      aliases: models.aliases,
    })
    .from(models)
    .where(inArray(models.providerId, providerIds))
  const byProvider = new Map<string, typeof targets>()
  for (const target of targets) {
    const group = byProvider.get(target.providerId) ?? []
    group.push(target)
    byProvider.set(target.providerId, group)
  }

  const resolved = new Map<string, ResolvedSameAs>()
  for (const { row, match } of candidates) {
    const nativeRows = byProvider.get(match.provider) ?? []
    const target = resolveAlias(
      match.rawId,
      nativeRows.map((native) => ({
        rawId: native.rawId,
        aliases: storedAliases(native.aliases),
      })),
    )
    if (target) {
      resolved.set(row.id, {
        target: { provider: match.provider, rawId: target.rawId },
        source: match.source,
      })
    }
  }
  return resolved
}
