/**
 * Azure OpenAI token prices from the public Azure Retail Prices API. It is
 * the only place Azure publishes these numbers as data: the pricing page
 * renders `$-` and fills the figures in the browser.
 *
 * A meter names its model only in the SKU name, an abbreviation such as
 * `5.4 mini cd Inp Gl` or `gpt-4o-0806-Outp-glbl`. `parseAzureSku` reads the
 * words it knows (direction, cache, deployment, version) and leaves the rest
 * as the model name. A SKU for another tier (batch, flex, priority,
 * fine-tuning, audio) keeps that word in its name and so matches no model.
 * Only Global Standard meters are read.
 *
 * A model with long-context meters gets no card: the API prices the two
 * bands and does not say where the long band starts.
 */
import { compileTokenCard } from '@modelschemas/rate-card'

import { tagDocsFacts } from './fact-sources.ts'
import { fetchJson, sha256Text } from './types.ts'
import type { ModelInfo } from './types.ts'

/**
 * Global Standard meters are listed in every region at one price, so one
 * region bounds the response without choosing a regional price.
 */
const FILTER =
  "serviceName eq 'Foundry Models' and armRegionName eq 'eastus2' and priceType eq 'Consumption' and startswith(productName,'Azure OpenAI')"
export const AZURE_PRICES_URL = `https://prices.azure.com/api/retail/prices?$filter=${encodeURIComponent(FILTER)}`

const MAX_PAGES = 10

const GLOBAL = new Set(['gl', 'glb', 'glbl', 'global'])
const INPUT = new Set(['in', 'inp', 'inpt', 'input'])
const OUTPUT = new Set(['opt', 'out', 'outp', 'outpt', 'output'])
const CACHED = new Set(['cd', 'cached', 'cchd', 'cched', 'ccchd'])
const LONG = new Set(['longco', 'loco'])
/** Words that say "standard, short context": the tier being read. */
const STANDARD = new Set(['std', 'shortco', 'shco'])

export type AzureLever =
  | 'input_tokens'
  | 'output_tokens'
  | 'cache_read_tokens'
  | 'cache_write_tokens'

export interface AzureSku {
  /** Model words with punctuation dropped: `54mini`, `gpt4o`, `o3`. */
  name: string
  /** `MMDD` of the model version, when the SKU carries one. */
  version: string | null
  lever: AzureLever
  long: boolean
}

export interface AzureMeter extends AzureSku {
  /** USD per token. */
  rate: number
}

/** `null` for a SKU that is not a Global Standard token meter. */
export function parseAzureSku(skuName: string): AzureSku | null {
  const words = skuName
    .toLowerCase()
    .split(/[\s-]+/)
    .filter(Boolean)
  if (!words.some((word) => GLOBAL.has(word))) return null

  let input = false
  let output = false
  let cached = false
  let write = false
  let long = false
  let version: string | null = null
  const name: Array<string> = []
  for (const word of words) {
    if (GLOBAL.has(word) || STANDARD.has(word)) continue
    if (INPUT.has(word)) input = true
    else if (OUTPUT.has(word)) output = true
    else if (CACHED.has(word)) cached = true
    else if (word === 'wr') write = true
    else if (LONG.has(word)) long = true
    // `0806`, or `08062026` on the dated chat-latest meters.
    else if (/^\d{4}(?:\d{4})?$/.test(word)) version = word.slice(0, 4)
    else name.push(word)
  }

  let lever: AzureLever
  if (cached && write && !input && !output) lever = 'cache_write_tokens'
  else if (write || input === output) return null
  else if (input) lever = cached ? 'cache_read_tokens' : 'input_tokens'
  else if (cached) return null
  else lever = 'output_tokens'

  const joined = name.join('').replace(/[^a-z0-9]/g, '')
  return joined === '' ? null : { name: joined, version, lever, long }
}

interface RetailItem {
  skuName?: string
  unitOfMeasure?: string
  retailPrice?: number
}

const UNIT_TOKENS: Record<string, number> = { '1K': 1e3, '1M': 1e6 }

export function parseAzureMeters(items: Array<RetailItem>): Array<AzureMeter> {
  const out: Array<AzureMeter> = []
  for (const item of items) {
    const tokens = UNIT_TOKENS[item.unitOfMeasure ?? '']
    const sku = parseAzureSku(item.skuName ?? '')
    if (!tokens || !sku || typeof item.retailPrice !== 'number') continue
    // 0.015 / 1000 is one bit short of 1.5e-5; round the division's noise.
    const rate = Number((item.retailPrice / tokens).toPrecision(12))
    out.push({ ...sku, rate })
  }
  return out
}

/**
 * Rates for one model version. `null` when no meter names the model, when
 * its meters are for other versions, when they price a long-context band,
 * when two meters disagree, or when input or output is missing.
 */
export function azureModelRates(
  meters: Array<AzureMeter>,
  rawId: string,
  version: string | null,
): Record<string, number> | null {
  const id = rawId.toLowerCase().replace(/[^a-z0-9]/g, '')
  const mine = meters.filter((m) => m.name === id || `gpt${m.name}` === id)
  // `2024-11-20` → `1120`
  const dated = version ? version.slice(5).replace('-', '') : null
  const exact = mine.filter((m) => m.version !== null && m.version === dated)
  const picked = exact.length > 0 ? exact : mine.filter((m) => !m.version)
  if (picked.length === 0 || picked.some((m) => m.long)) return null

  const rates: Record<string, number> = {}
  for (const meter of picked) {
    const known = rates[meter.lever]
    if (known !== undefined && known !== meter.rate) return null
    rates[meter.lever] = meter.rate
  }
  return rates.input_tokens !== undefined && rates.output_tokens !== undefined
    ? rates
    : null
}

export interface AzurePriceDoc {
  meters: Array<AzureMeter>
  hash: string
  extractedAt: string
}

/** Every page of the price list. Throws when no token meter parses. */
export async function fetchAzurePrices(): Promise<AzurePriceDoc> {
  const items: Array<RetailItem> = []
  let url: string | null = AZURE_PRICES_URL
  for (let page = 0; url; page++) {
    if (page === MAX_PAGES) {
      throw new Error(`azure: price list runs past ${String(MAX_PAGES)} pages`)
    }
    const body = (await fetchJson(url)) as {
      Items?: Array<RetailItem>
      NextPageLink?: string | null
    }
    items.push(...(body.Items ?? []))
    url = body.NextPageLink ?? null
  }
  const meters = parseAzureMeters(items)
  if (meters.length === 0) {
    throw new Error('azure: price list held no Global Standard token meters')
  }
  // Page order is not stable; hash the meters, sorted.
  const lines = meters.map((m) => JSON.stringify(m)).sort()
  return {
    meters,
    hash: await sha256Text(lines.join('\n')),
    extractedAt: new Date().toISOString(),
  }
}

export function azureModelPricing(
  doc: AzurePriceDoc,
  rawId: string,
  version: string | null,
): Pick<ModelInfo, 'pricing' | 'factSources'> {
  const rates = azureModelRates(doc.meters, rawId, version)
  const pricing =
    rates &&
    compileTokenCard(rates, [], {
      url: AZURE_PRICES_URL,
      hash: doc.hash,
      extractedAt: doc.extractedAt,
    })
  if (!pricing) return {}
  return {
    pricing,
    factSources: tagDocsFacts({ pricing }, AZURE_PRICES_URL, doc.hash),
  }
}
