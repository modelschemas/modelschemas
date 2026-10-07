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
 * The API prices a short and a long context band for some models and does
 * not say where the long band starts. The pricing page's row labels do for
 * a few (`GPT-5.4 (<272k context length)`); those get a tiered card. A model
 * with long-context meters and no published threshold gets no card.
 */
import { compileTokenCard } from '@modelschemas/rate-card'

import { fetchJson, fetchText, sha256Text } from './types.ts'
import type { ModelInfo } from './types.ts'

/**
 * Global Standard meters are listed in every region at one price, so one
 * region bounds the response without choosing a regional price.
 */
const FILTER =
  "serviceName eq 'Foundry Models' and armRegionName eq 'eastus2' and priceType eq 'Consumption' and startswith(productName,'Azure OpenAI')"
export const AZURE_PRICES_URL = `https://prices.azure.com/api/retail/prices?$filter=${encodeURIComponent(FILTER)}`

/** Read only for the context-length labels on its rows. */
export const AZURE_PRICING_PAGE_URL =
  'https://azure.microsoft.com/en-us/pricing/details/azure-openai/'

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
    // `gpt-4-turbo128K` is the Global Standard meter for the `gpt-4` row.
    // `gpt-4-Turbo-Batch-128K` stays a different name: its words are split.
    if (word === 'turbo128k') continue
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
    // Stored as a per-million figure over 1e6, like every other provider,
    // so the served per-million price is the meter's. The product itself
    // carries float noise (0.00003 * 1000), hence the rounding.
    const perMillion = Number(
      (item.retailPrice * (1e6 / tokens)).toPrecision(12),
    )
    out.push({ ...sku, rate: perMillion / 1e6 })
  }
  return out
}

function ratesOf(meters: Array<AzureMeter>): Record<string, number> | null {
  const rates: Record<string, number> = {}
  for (const meter of meters) {
    const known = rates[meter.lever]
    if (known !== undefined && known !== meter.rate) return null
    rates[meter.lever] = meter.rate
  }
  return rates.input_tokens !== undefined && rates.output_tokens !== undefined
    ? rates
    : null
}

function names(meter: AzureMeter, rawId: string): boolean {
  const id = rawId.toLowerCase().replace(/[^a-z0-9]/g, '')
  // `computer-use-inpt-glbl` is the meter for `computer-use-preview`.
  // The suffix is only appended, so a meter that already names the full id
  // still matches that id and not a shorter one.
  return (
    meter.name === id ||
    `gpt${meter.name}` === id ||
    `${meter.name}preview` === id
  )
}

/**
 * Whether a Global Standard token meter names this id and none of `taken`.
 * `chat-latest` is OpenAI's name for `gpt-chat-latest`; its meter belongs to
 * the tabulated model, so the bare name is not a second one.
 */
export function azureMetered(
  meters: Array<AzureMeter>,
  rawId: string,
  taken: Array<string> = [],
): boolean {
  return meters.some(
    (meter) =>
      names(meter, rawId) && !taken.some((other) => names(meter, other)),
  )
}

export interface AzureRates {
  base: Record<string, number>
  /** The long-context band, when the model's meters price one. */
  long: Record<string, number> | null
}

/**
 * Rates for one model version. `null` when no meter names the model, when
 * its meters are for other versions, when two meters disagree, or when a
 * band lacks input or output.
 */
export function azureModelRates(
  meters: Array<AzureMeter>,
  rawId: string,
  version: string | null,
): AzureRates | null {
  const mine = meters.filter((meter) => names(meter, rawId))
  // `2024-11-20` → `1120`
  const dated = version ? version.slice(5).replace('-', '') : null
  const exact = mine.filter((m) => m.version !== null && m.version === dated)
  const picked = exact.length > 0 ? exact : mine.filter((m) => !m.version)

  const base = ratesOf(picked.filter((m) => !m.long))
  const longMeters = picked.filter((m) => m.long)
  const long = longMeters.length > 0 ? ratesOf(longMeters) : null
  if (!base || (longMeters.length > 0 && !long)) return null
  return { base, long }
}

/**
 * Where the long-context band starts, from the pricing page's row labels:
 * `GPT-5.4 Pro (<272k context length)` and its `>272k` twin give
 * `gpt-5.4-pro` → 272000. A model with one label, or with labels that
 * disagree, is left out. Rows labelled only "short context" state nothing.
 */
export function parseAzureContextThresholds(html: string): Map<string, number> {
  const seen = new Map<string, { lt: Set<number>; gt: Set<number> }>()
  for (const match of html.matchAll(
    /GPT-(\d[\d.]*(?: [A-Za-z]+)*) \((?:&(lt|gt);|([<>]))(\d+)k context length\)/g,
  )) {
    const id = `gpt-${(match[1] ?? '').toLowerCase().replace(/ /g, '-')}`
    const entry = seen.get(id) ?? { lt: new Set(), gt: new Set() }
    const below = match[2] === 'lt' || match[3] === '<'
    entry[below ? 'lt' : 'gt'].add(Number(match[4]) * 1000)
    seen.set(id, entry)
  }
  const out = new Map<string, number>()
  for (const [id, { lt, gt }] of seen) {
    const [tokens] = lt
    if (
      tokens !== undefined &&
      lt.size === 1 &&
      gt.size === 1 &&
      gt.has(tokens)
    ) {
      out.set(id, tokens)
    }
  }
  return out
}

export interface AzurePriceDoc {
  meters: Array<AzureMeter>
  /** Model id → prompt tokens above which the long band applies. */
  thresholds: Record<string, number>
  hash: string
  extractedAt: string
}

async function fetchMeters(): Promise<Array<AzureMeter>> {
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
  return meters
}

/**
 * Every page of the price list plus the pricing page's thresholds. Throws
 * when either parses nothing.
 */
export async function fetchAzurePrices(): Promise<AzurePriceDoc> {
  const [meters, html] = await Promise.all([
    fetchMeters(),
    fetchText(AZURE_PRICING_PAGE_URL),
  ])
  const thresholds = parseAzureContextThresholds(html)
  if (thresholds.size === 0) {
    throw new Error('azure: pricing page labels no context-length threshold')
  }
  // Page order is not stable; hash the meters, sorted.
  const lines = meters.map((m) => JSON.stringify(m)).sort()
  lines.push(JSON.stringify([...thresholds].sort()))
  return {
    meters,
    thresholds: Object.fromEntries(thresholds),
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
  if (!rates) return {}
  const threshold = doc.thresholds[rawId]
  // Never the short band alone for a model that also has a long one.
  if (rates.long && threshold === undefined) return {}
  const pricing = compileTokenCard(
    rates.base,
    rates.long && threshold !== undefined
      ? [{ minPromptTokens: threshold, rates: rates.long }]
      : [],
    { url: AZURE_PRICES_URL, hash: doc.hash, extractedAt: doc.extractedAt },
  )
  if (!pricing) return {}
  return {
    pricing,
    factSources: {
      pricing: {
        derivation: 'docs-derived',
        sourceUrl: AZURE_PRICES_URL,
        sourceHash: doc.hash,
        path: rates.long
          ? `Pricing; long-context threshold: ${AZURE_PRICING_PAGE_URL}`
          : 'Pricing',
      },
    },
  }
}
