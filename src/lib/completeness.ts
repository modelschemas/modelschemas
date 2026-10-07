/**
 * Completeness: the share of the chat facts `@tanstack/ai-models` needs that
 * a provider's rows carry. The one definition behind `bun run gap:report`
 * (`scripts/gap-report.ts`) and `completeness` on `GET /v1/status`, so the
 * CLI and the site cannot disagree. No Node or Workers dependencies.
 *
 * `docs/source-silent/<provider>.md` lists facts a provider does not publish;
 * those are left out of that provider's score and listed under `silent`.
 */
export const FACT_KEYS = [
  'contextWindow',
  'maxOutput',
  'modalities',
  'priced',
  'cacheRead',
  'capabilities',
  'reasoning',
  'efforts',
  'requestMap',
  'endpoint',
] as const

export type FactKey = (typeof FACT_KEYS)[number]

/** The fields of a `/v1/models` row the report reads. */
export type ModelRow = {
  provider: string
  activity?: string | null
  contextWindow?: number | null
  maxOutput?: number | null
  modalities?: { input?: unknown } | null
  pricing?: {
    tables?: { rate?: { base?: unknown } }
    source?: { url?: string }
  } | null
  capabilities?: unknown
  reasoning?: {
    mode?: string
    mandatory?: boolean | null
    efforts?: Array<string>
  } | null
  requestMap?: unknown
  schemaEndpointId?: string | null
}

export type ProviderReport = {
  provider: string
  rows: number
  chat: number
  noActivity: number
  fromModelsDev: number
  facts: Record<FactKey, { have: number; need: number }>
  silent: Array<FactKey>
  score: number
}

export type GapReport = {
  generatedAt: string
  providers: Array<ProviderReport>
}

/** provider id → facts that provider does not publish. */
export type Ledger = Map<string, Set<FactKey>>

function isFactKey(value: string): value is FactKey {
  return (FACT_KEYS as ReadonlyArray<string>).includes(value)
}

/** Ledger entries are list lines: `- <provider>: <fact> — <why>`. */
export function parseLedger(markdown: string): Ledger {
  const ledger: Ledger = new Map()
  for (const line of markdown.split('\n')) {
    const match = /^- `?([\w.-]+)`?: `?(\w+)`?/.exec(line)
    if (!match) continue
    const [, provider, fact] = match
    if (!provider || !fact || !isFactKey(fact)) {
      throw new Error(
        `source-silent ledger: unknown fact "${fact}" in: ${line}`,
      )
    }
    const facts = ledger.get(provider) ?? new Set<FactKey>()
    facts.add(fact)
    ledger.set(provider, facts)
  }
  return ledger
}

function isModelsDev(row: ModelRow): boolean {
  const url = row.pricing?.source?.url
  if (!url) return false
  try {
    const { hostname } = new URL(url)
    return hostname === 'models.dev' || hostname.endsWith('.models.dev')
  } catch {
    return false
  }
}

/** The base rate row, or null when absent or a models.dev price. */
function baseRate(row: ModelRow): Record<string, unknown> | null {
  if (isModelsDev(row)) return null
  const base = row.pricing?.tables?.rate?.base
  return typeof base === 'object' && base !== null
    ? (base as Record<string, unknown>)
    : null
}

// Listing-compiled cards use OpenRouter's key names, parsed cards ours.
function hasRate(row: ModelRow, ...keys: Array<string>): boolean {
  const base = baseRate(row)
  return base !== null && keys.some((key) => typeof base[key] === 'number')
}

function capabilityList(row: ModelRow): Array<unknown> {
  return Array.isArray(row.capabilities) ? row.capabilities : []
}

/** `need`: the fact applies to this row. `have`: the row carries it. */
const FACTS: Record<
  FactKey,
  { need?: (row: ModelRow) => boolean; have: (row: ModelRow) => boolean }
> = {
  contextWindow: { have: (row) => row.contextWindow != null },
  maxOutput: { have: (row) => row.maxOutput != null },
  modalities: {
    have: (row) => {
      const input = row.modalities?.input
      return Array.isArray(input) && input.length > 0
    },
  },
  priced: {
    have: (row) =>
      hasRate(row, 'input_tokens', 'prompt') &&
      hasRate(row, 'output_tokens', 'completion'),
  },
  cacheRead: {
    have: (row) => hasRate(row, 'cache_read_tokens', 'input_cache_read'),
  },
  capabilities: { have: (row) => Array.isArray(row.capabilities) },
  // Filled by any stored object, whatever its `mandatory`: null there means
  // the source is silent on turning thinking off, which is a stored fact.
  reasoning: {
    need: (row) =>
      row.reasoning != null || capabilityList(row).includes('reasoning'),
    have: (row) => row.reasoning != null,
  },
  // Only `effort` and `adaptive` rows need effort names; a `toggle` or
  // `budget` row needs none. `mandatory` plays no part: efforts with
  // `mandatory: null` is filled.
  efforts: {
    need: (row) =>
      row.reasoning?.mode === 'effort' || row.reasoning?.mode === 'adaptive',
    have: (row) => (row.reasoning?.efforts?.length ?? 0) > 0,
  },
  requestMap: { have: (row) => row.requestMap != null },
  endpoint: { have: (row) => row.schemaEndpointId != null },
}

/** Facts filled and facts needed across a provider, ledgered ones left out. */
export function scoredFacts(report: Pick<ProviderReport, 'facts' | 'silent'>): {
  have: number
  need: number
} {
  let have = 0
  let need = 0
  for (const key of FACT_KEYS) {
    if (report.silent.includes(key)) continue
    have += report.facts[key].have
    need += report.facts[key].need
  }
  return { have, need }
}

export function buildReport(
  rows: Array<ModelRow>,
  ledger: Ledger = new Map(),
  now: Date = new Date(),
): GapReport {
  const byProvider = new Map<string, Array<ModelRow>>()
  for (const row of rows) {
    const group = byProvider.get(row.provider)
    if (group) group.push(row)
    else byProvider.set(row.provider, [row])
  }

  const providers = [...byProvider].map(([provider, group]): ProviderReport => {
    const chat = group.filter((row) => row.activity === 'chat')
    const silent = FACT_KEYS.filter((key) => ledger.get(provider)?.has(key))
    const facts = Object.fromEntries(
      FACT_KEYS.map((key) => {
        const { need, have } = FACTS[key]
        const needed = need ? chat.filter(need) : chat
        return [key, { have: needed.filter(have).length, need: needed.length }]
      }),
    ) as ProviderReport['facts']
    const { have, need } = scoredFacts({ facts, silent })

    return {
      provider,
      rows: group.length,
      chat: chat.length,
      noActivity: group.filter((row) => row.activity == null).length,
      fromModelsDev: group.filter(isModelsDev).length,
      facts,
      silent,
      // No chat rows is a gap, not a pass. Chat rows with every needed fact
      // on the ledger have nothing left to fill.
      score: need === 0 ? (chat.length > 0 ? 1 : 0) : have / need,
    }
  })

  providers.sort(
    (a, b) => a.score - b.score || a.provider.localeCompare(b.provider),
  )
  return { generatedAt: now.toISOString(), providers }
}
