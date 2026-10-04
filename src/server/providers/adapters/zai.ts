/**
 * Z.AI — model ids are the enums in docs.z.ai/openapi.json.
 * Token prices come from the pricing page when a row lowercases onto one
 * of those ids. USD per 1M tokens. A row that does not match an enum is ignored.
 */
import { compileTokenCard } from '@modelschemas/rate-card'
import type { RateCard } from '@modelschemas/rate-card'

import type { Activity } from '#/db/schema.ts'

import { fetchOpenApi, fetchText, sha256Text } from '../types.ts'
import type {
  ListModelsResult,
  ModelInfo,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

export const ZAI_OPENAPI_URL = 'https://docs.z.ai/openapi.json'
export const ZAI_PRICING_URL = 'https://docs.z.ai/guides/overview/pricing.md'

interface TokenPrice {
  input: number
  output: number
  cache: number | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function money(cell: string): number | null {
  const match = cell.match(/\$([0-9]+(?:\.[0-9]+)?)/)
  if (!match?.[1]) return null
  const value = Number(match[1])
  return Number.isFinite(value) && value > 0 ? value : null
}

export function zaiModelIds(spec: unknown): Array<string> {
  const ids = new Set<string>()
  const walk = (node: unknown) => {
    if (!isRecord(node)) return
    if (Array.isArray(node.enum)) {
      for (const value of node.enum) {
        if (
          typeof value === 'string' &&
          /^(?:glm|cog)[a-z0-9._-]*$/.test(value)
        ) {
          ids.add(value)
        }
      }
    }
    for (const value of Object.values(node)) walk(value)
  }
  walk(spec)
  if (ids.size === 0) throw new Error('zai: OpenAPI has no model enums')
  return [...ids].sort()
}

/** Per-1M-token tables. The key is the model cell lowercased. */
export function parseZaiTokenPrices(markdown: string): Map<string, TokenPrice> {
  if (!/per 1M tokens/i.test(markdown)) {
    throw new Error('zai: pricing page has no per-1M-token table')
  }
  const prices = new Map<string, TokenPrice>()
  let inTokenTable = false
  for (const line of markdown.split('\n')) {
    if (/per 1M tokens/i.test(line)) {
      inTokenTable = true
      continue
    }
    if (/^#{1,3} /.test(line)) {
      inTokenTable = false
      continue
    }
    if (!inTokenTable || !line.startsWith('|')) continue
    if (/^\|\s*:?-+/.test(line)) continue
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim())
    const name = cells[0]
    if (!name || name === 'Model' || cells.length < 5) continue
    const input = money(cells[1] ?? '')
    const output = money(cells[4] ?? '')
    if (input === null || output === null) continue
    prices.set(name.toLowerCase(), {
      input,
      output,
      cache: money(cells[2] ?? ''),
    })
  }
  return prices
}

export function parseZaiModels(
  spec: unknown,
  markdown: string,
  source: RateCard['source'],
): Array<ModelInfo> {
  const prices = parseZaiTokenPrices(markdown)
  return zaiModelIds(spec).map((rawId) => {
    const price = prices.get(rawId)
    const rates = price
      ? {
          input_tokens: price.input / 1_000_000,
          output_tokens: price.output / 1_000_000,
          ...(price.cache !== null
            ? { cache_read_tokens: price.cache / 1_000_000 }
            : {}),
        }
      : null
    return {
      rawId,
      pricing: rates ? compileTokenCard(rates, [], source) : null,
    }
  })
}

async function listModels(_env: ProviderSecrets): Promise<ListModelsResult> {
  const [specText, pricing] = await Promise.all([
    fetchText(ZAI_OPENAPI_URL),
    fetchText(ZAI_PRICING_URL),
  ])
  return {
    models: parseZaiModels(JSON.parse(specText) as unknown, pricing, {
      url: ZAI_PRICING_URL,
      hash: await sha256Text(pricing),
      extractedAt: new Date().toISOString(),
    }),
  }
}

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const { spec, hash } = await fetchOpenApi(ZAI_OPENAPI_URL)
  return {
    specs: [spec],
    sources: [{ url: ZAI_OPENAPI_URL, hash }],
    outputStrategy: 'post-200',
    specRevision: hash,
  }
}

export function classifyZaiPath(path: string): Activity | null {
  if (path.includes('/chat/completions')) return 'chat'
  if (path.includes('/images/')) return 'image'
  if (path.includes('/videos/')) return 'video'
  if (path.includes('/audio/')) return 'audio'
  return null
}

export const provider: ProviderConfig = {
  id: 'zai',
  displayName: 'Z.AI',
  specSourceUrl: ZAI_OPENAPI_URL,
  modelsEndpoint: ZAI_OPENAPI_URL,
  defaultDerivation: 'upstream-spec',
  fetchSpec,
  listModels,
  classify: (path) => classifyZaiPath(path),
}
