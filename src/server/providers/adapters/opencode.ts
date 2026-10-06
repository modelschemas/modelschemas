/**
 * OpenCode Zen — ids from the provider's public models list, facts from
 * its docs page.
 *
 * The list publishes ids only (`created` is the request time). The docs
 * page's Endpoints table names each model's route, which classifies the
 * row, and its Pricing table quotes USD per 1M tokens. The route is not
 * stored: no OpenAPI document exists for `schemaEndpointId` to bind to.
 * Context window, output cap, modalities, capabilities, and reasoning are
 * published nowhere (docs/source-silent.md).
 */
import { compileTokenCard } from '@modelschemas/rate-card'
import type { TokenRateTier } from '@modelschemas/rate-card'

import type { Activity } from '#/db/schema.ts'

import {
  cachedDocs,
  markdownSection,
  markdownTableRows,
} from '../model-facts.ts'
import { fetchJson, fetchText, sha256Text } from '../types.ts'
import type {
  ListModelsResult,
  ModelInfo,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

export const OPENCODE_MODELS_URL = 'https://opencode.ai/zen/v1/models'

/** Page readers see; the facts are parsed from its markdown twin. */
export const OPENCODE_DOCS_URL = 'https://opencode.ai/docs/zen'

export const OPENCODE_DOCS_MARKDOWN = `${OPENCODE_DOCS_URL}.md`

const SPEC_SKIP = 'opencode: no first-party OpenAPI document — skipped'

const FETCH_TIMEOUT_MS = 30_000

const ENDPOINT_HEADER = ['Model', 'Model ID', 'Endpoint', 'AI SDK Package']
const PRICING_HEADER = [
  'Model',
  'Input',
  'Output',
  'Cached Read',
  'Cached Write',
]
const PRICE_LEVERS = [
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
]

/** Routes that take a text-generation request. Any other route is unclassified. */
const CHAT_ROUTES = new Set([
  'v1/responses',
  'v1/messages',
  'v1/chat/completions',
])

interface Rates {
  base: Record<string, number>
  tiers: Array<TokenRateTier>
}

export interface ZenDocsModel {
  displayName: string
  activity: Activity | null
  /** Null when the Pricing table has no usable row for this model. */
  rates: Rates | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sameCells(row: Array<string> | undefined, header: Array<string>) {
  return row?.length === header.length && row.every((c, i) => c === header[i])
}

/** `$1.25` → USD per token, `Free` → 0, `-` → null (not quoted), else undefined. */
function rateCell(cell: string): number | null | undefined {
  if (cell === '-') return null
  if (cell === 'Free') return 0
  const match = cell.match(/^\$(\d+(?:\.\d+)?)$/)
  return match?.[1] ? Number(match[1]) / 1e6 : undefined
}

/**
 * Pricing table → rates by model name. `Name (≤ 200K tokens)` is the base
 * row and `Name (> 200K tokens)` its tier. A name with a cell or a
 * qualifier pairing this does not recognise maps to null.
 */
function parsePricing(markdown: string): Map<string, Rates | null> {
  const section = markdownSection(markdown, 'Pricing').split('\n### ')[0] ?? ''
  const rows = markdownTableRows(section)
  if (
    !section.includes('per 1M tokens') ||
    !sameCells(rows[0], PRICING_HEADER)
  ) {
    throw new Error('opencode: docs Pricing table is not per-1M-token rates')
  }
  type Slot = { rates: Record<string, number>; at: number | null }
  const slots = new Map<string, { base?: Slot; tier?: Slot; bad?: true }>()
  for (const row of rows.slice(1)) {
    const match = row[0]?.match(/^(.+?)(?: \((≤|>) (\d+)K tokens\))?$/)
    const name = match?.[1]
    if (!match || !name) continue
    const entry = slots.get(name) ?? {}
    slots.set(name, entry)
    const rates: Record<string, number> = {}
    const cells = row.slice(1).map(rateCell)
    if (row.length !== PRICING_HEADER.length || cells.includes(undefined)) {
      entry.bad = true
      continue
    }
    cells.forEach((value, index) => {
      const lever = PRICE_LEVERS[index]
      if (lever && typeof value === 'number') rates[lever] = value
    })
    const slot = match[2] === '>' ? 'tier' : 'base'
    if (entry[slot]) entry.bad = true
    entry[slot] = { rates, at: match[3] ? Number(match[3]) * 1000 : null }
  }
  const out = new Map<string, Rates | null>()
  for (const [name, { base, tier, bad }] of slots) {
    // A tier row needs its `≤` base row at the same threshold, and back.
    // It must also quote every rate the base does: the compiled tier fills
    // a missing lever from the base, which would invent a tier price.
    const unquoted =
      base && tier && Object.keys(base.rates).some((k) => !(k in tier.rates))
    if (bad || !base || unquoted || (tier?.at ?? null) !== base.at) {
      out.set(name, null)
      continue
    }
    out.set(name, {
      base: base.rates,
      tiers:
        tier?.at != null
          ? // The page says only `(> 272K tokens)`, not what is counted. The
            // card counts prompt tokens: input plus cache read and write.
            [{ minPromptTokens: tier.at, rates: tier.rates }]
          : [],
    })
  }
  return out
}

/** Endpoints and Pricing tables of the Zen docs page, keyed by model id. */
export function parseZenDocs(markdown: string): Record<string, ZenDocsModel> {
  // A 200 that is an HTML error page must not be read as the document.
  if (/^\s*<(?:!doctype|html)/i.test(markdown)) {
    throw new Error('opencode: docs page returned HTML, not markdown')
  }
  const rows = markdownTableRows(markdownSection(markdown, 'Endpoints'))
  if (!sameCells(rows[0], ENDPOINT_HEADER)) {
    throw new Error('opencode: docs Endpoints table not found')
  }
  const prices = parsePricing(markdown)
  const byId: Record<string, ZenDocsModel> = {}
  let priced = 0
  for (const row of rows.slice(1)) {
    const [name, id, endpointCell] = row
    const endpoint = endpointCell?.match(
      /^`https:\/\/opencode\.ai\/zen\/(v1\/[^`\s]+)`$/,
    )?.[1]
    if (row.length !== ENDPOINT_HEADER.length || !name || !id || !endpoint) {
      throw new Error(`opencode: unreadable Endpoints row: ${row.join(' | ')}`)
    }
    if (id in byId) throw new Error(`opencode: duplicate model id ${id}`)
    const rates = prices.get(name) ?? null
    if (rates) priced += 1
    byId[id] = {
      displayName: name,
      // Gemini models are served at `v1/models/<id>`.
      activity:
        CHAT_ROUTES.has(endpoint) || endpoint === `v1/models/${id}`
          ? 'chat'
          : null,
      rates,
    }
  }
  if (priced === 0) throw new Error('opencode: docs priced 0 model rows')
  return byId
}

export function parseOpencodeModels(payload: unknown): Array<ModelInfo> {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error('opencode: models payload has no data array')
  }
  const models: Array<ModelInfo> = []
  for (const row of payload.data) {
    if (!isRecord(row) || typeof row.id !== 'string' || row.id.length === 0) {
      continue
    }
    models.push({
      rawId: row.id,
      releasedAt:
        typeof row.created === 'number' && row.created > 0 ? row.created : null,
      pricing: null,
    })
  }
  if (models.length === 0) {
    throw new Error('opencode: models payload listed no ids')
  }
  return models
}

async function listModels(
  _env: ProviderSecrets,
  kv?: KVNamespace,
): Promise<ListModelsResult> {
  const signal = () => AbortSignal.timeout(FETCH_TIMEOUT_MS)
  const payload = await fetchJson(OPENCODE_MODELS_URL, { signal: signal() })
  const docs = await cachedDocs(kv, OPENCODE_DOCS_MARKDOWN, async () => {
    const markdown = await fetchText(OPENCODE_DOCS_MARKDOWN, {
      signal: signal(),
    })
    return {
      byId: parseZenDocs(markdown),
      hash: await sha256Text(markdown),
      extractedAt: new Date().toISOString(),
    }
  })
  const source = {
    url: OPENCODE_DOCS_URL,
    hash: docs.hash,
    extractedAt: docs.extractedAt,
  }
  const models = parseOpencodeModels(payload).map((model): ModelInfo => {
    const row = docs.byId[model.rawId]
    if (!row) return model
    const pricing = row.rates
      ? compileTokenCard(row.rates.base, row.rates.tiers, source)
      : null
    return {
      ...model,
      displayName: row.displayName,
      activity: row.activity,
      pricing,
      ...(pricing
        ? {
            factSources: {
              pricing: {
                derivation: 'docs-derived',
                sourceUrl: OPENCODE_DOCS_URL,
                sourceHash: docs.hash,
                path: 'Pricing',
              },
            },
          }
        : {}),
    }
  })
  return { models }
}

function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  return Promise.resolve({
    specs: [],
    sources: [],
    outputStrategy: 'post-200',
    skipped: SPEC_SKIP,
  })
}

export const provider: ProviderConfig = {
  id: 'opencode',
  displayName: 'OpenCode Zen',
  specSourceUrl: OPENCODE_DOCS_URL,
  modelsEndpoint: OPENCODE_MODELS_URL,
  defaultDerivation: 'docs-derived',
  fetchSpec,
  listModels,
  classify: () => null,
}
