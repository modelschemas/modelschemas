/**
 * Standard-tier Bedrock token prices from AWS's own price list and the
 * public pricing page. The us-east-1 offer is the in-region / standard
 * rate. The pricing page fills marketplace models the offer does not
 * name (Anthropic, AI21, Cohere); only Geo and in-region tables, never
 * Global, batch, flex, or priority. A card that already states dollars
 * wins. A page or offer that parses nothing throws.
 */
import { assertParsed } from './model-facts.ts'
import { fetchText, sha256Text } from './types.ts'

const AWS_INIT = {
  headers: {
    'User-Agent': 'modelschemas (+https://modelschemas.openstory.workers.dev)',
  },
}

export const BEDROCK_PRICE_LIST_URL =
  'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrock/current/us-east-1/index.json'
export const BEDROCK_PRICING_PAGE_URL =
  'https://aws.amazon.com/bedrock/pricing/'
export const BEDROCK_METERED_URL =
  'https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/bedrockfoundationmodels/USD/current/bedrockfoundationmodels.json'

const USE1 = 'US East (N. Virginia)'
const NONSTANDARD =
  /batch|priority|flex|global|cross-region|latency|govcloud|provisioned|custom|training|reserved/i
const SKIP_HEADING =
  /global|priority|flex|\bbatch\b|reserved|latency|provisioned|custom|fine-tun|training|embedding|speech|creative|guardrail|evaluation|example/i

const INPUT = 'input_tokens'
const OUTPUT = 'output_tokens'

interface OfferDimension {
  unit?: string
  beginRange?: string
  endRange?: string
  pricePerUnit?: { USD?: string }
}

interface OfferFile {
  products?: Record<string, { attributes?: Record<string, string> }>
  terms?: {
    OnDemand?: Record<
      string,
      Record<string, { priceDimensions?: Record<string, OfferDimension> }>
    >
  }
}

interface MeterFile {
  regions?: Record<string, Record<string, { price?: string }>>
}

export interface BedrockPriceBook {
  offerById: Map<string, Record<string, number>>
  offerByName: Map<string, Record<string, number>>
  /** Offer display name, dotted decimals collapsed (`25.02` → `2502`). */
  offerBySlug: Map<string, Record<string, number>>
  pageByName: Map<string, Record<string, number>>
  offerHash: string
  pageHash: string
}

export interface BedrockPriceHit {
  rates: Record<string, number>
  url: string
  hash: string
}

function close(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-12
}

function sameRates(
  a: Record<string, number>,
  b: Record<string, number>,
): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of keys) {
    if (
      a[key] === undefined ||
      b[key] === undefined ||
      !close(a[key], b[key])
    ) {
      return false
    }
  }
  return true
}

/** Last write wins until two different rate maps share a key; then the key is dropped. */
function assign(
  map: Map<string, Record<string, number>>,
  dropped: Set<string>,
  key: string,
  rates: Record<string, number>,
): void {
  if (dropped.has(key)) return
  const prev = map.get(key)
  if (!prev) {
    map.set(key, rates)
    return
  }
  if (sameRates(prev, rates)) return
  map.delete(key)
  dropped.add(key)
}

function complete(rates: Record<string, number>): boolean {
  return (rates[INPUT] ?? 0) > 0 && (rates[OUTPUT] ?? 0) > 0
}

const CLAUDE_FAMILY = 'haiku|sonnet|opus|fable|mythos'

/**
 * `Nova 2.0 Lite` and `Llama 4 Maverick 17B Instruct` share one key.
 * `+` stays so Command R and Command R+ stay apart. A markdown `\+`
 * is the same plus. Claude puts the family on either side of the
 * version (`Claude Haiku 4.5`, `Claude 4.5 Haiku`); other names keep
 * their token order (`Ministral 3 8B` is not `Ministral 8B 3`).
 */
export function bedrockNameKey(name: string): string {
  const key = name
    .replace(/\\/g, '')
    .toLowerCase()
    .replace(/\b(\d+)\.0+\b/g, '$1')
    .replace(/[^a-z0-9+]+/g, ' ')
    .replace(/\s+instruct$/, '')
    .replace(/\s+/g, ' ')
    .trim()
  const match = key.match(
    new RegExp(
      `^claude(?:\\s+(${CLAUDE_FAMILY}))?\\s+((?:\\d+\\s+)*\\d+)(?:\\s+(${CLAUDE_FAMILY}))?$`,
    ),
  )
  const family = match?.[1] || match?.[3]
  if (!match?.[2] || !family) return key
  if (match[1] && match[3] && match[1] !== match[3]) return key
  return `claude ${match[2]} ${family}`
}

function usageModelId(usagetype: string): string | null {
  const dotted = usagetype
    .replace(/^[A-Z0-9]+-/, '')
    .match(/^([a-z][a-z0-9]*\.[a-z0-9][a-z0-9.:-]*)/)?.[1]
  if (!dotted) return null
  return dotted
    .replace(/-mantle(?:-.*)?$/, '')
    .replace(/-(?:input|output)-tokens(?:-.*)?$/, '')
    .replace(/-cache-(?:read|write)(?:-.*)?$/, '')
}

/**
 * 5-minute and unnamed writes use `cache_write_tokens`. A 1-hour write is
 * its own lever. 30-minute and any other duration have no lever.
 */
const FIVE_MINUTES = /(?:^|[^a-z0-9])5(?:m|[\s-]*min(?:ute)?s?)(?:[^a-z0-9]|$)/
const ONE_HOUR = /(?:^|[^a-z0-9])1(?:h|[\s-]*hours?)(?:[^a-z0-9]|$)/
const OTHER_DURATION =
  /(?:^|[^a-z0-9])\d+\s*(?:m|h)\b|\d+\s*-?\s*(?:min(?:ute)?s?|hours?)\b/

export function cacheWriteLever(text: string): string | null {
  const name = text.toLowerCase()
  if (ONE_HOUR.test(name)) return 'cache_write_1h_tokens'
  if (FIVE_MINUTES.test(name)) return 'cache_write_tokens'
  if (OTHER_DURATION.test(name)) return null
  return 'cache_write_tokens'
}

/** True when the header itself names a cache duration, including 30 minutes. */
export function cacheWriteNamesDuration(text: string): boolean {
  return OTHER_DURATION.test(text.toLowerCase())
}

/** `Pixtral Large 25.02` → `pixtral-large-2502`, the form inside the model id. */
export function bedrockOfferSlug(model: string): string {
  return model
    .toLowerCase()
    .replace(/(\d)\.(\d)/g, '$1$2')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function textLever(inferenceType: string, usagetype: string): string | null {
  const text = `${inferenceType} ${usagetype}`.toLowerCase()
  if (/video|image|audio|speech/.test(text)) return null
  if (/cache[- ]read/.test(text)) return 'cache_read_tokens'
  if (/cache[- ]write/.test(text)) return cacheWriteLever(text)
  if (/output/.test(text)) return OUTPUT
  if (/input/.test(text)) return INPUT
  return null
}

function isMedia(inferenceType: string, usagetype: string): boolean {
  return /video|image|audio|speech/i.test(`${inferenceType} ${usagetype}`)
}

function isStandard(attributes: Record<string, string>): boolean {
  const tier = attributes.service_tier ?? ''
  const feature = attributes.feature ?? ''
  const inferenceType = attributes.inferenceType ?? ''
  const usagetype = attributes.usagetype ?? ''
  if (
    NONSTANDARD.test(tier) ||
    NONSTANDARD.test(feature) ||
    NONSTANDARD.test(inferenceType) ||
    NONSTANDARD.test(usagetype)
  ) {
    return false
  }
  if (tier === 'standard') return true
  return tier === '' && feature === 'On-demand Inference'
}

function perToken(dimension: OfferDimension): number | null {
  const unit = dimension.unit?.match(/^(\d+(?:\.\d+)?)([km]) tokens?$/i)
  if (!unit || dimension.beginRange !== '0' || dimension.endRange !== 'Inf') {
    return null
  }
  const tokens = Number(unit[1]) * (unit[2]?.toLowerCase() === 'm' ? 1e6 : 1e3)
  const usd = Number(dimension.pricePerUnit?.USD)
  if (!Number.isFinite(usd) || tokens <= 0) return null
  return usd / tokens
}

interface Group {
  rates: Record<string, number>
  media: boolean
  conflict: boolean
  name: string
  nameConflict: boolean
  slug: string
  slugConflict: boolean
}

/**
 * Standard on-demand token rates. Speech and text prices for one model
 * (Nova Sonic) are a conflict: the model is dropped, not averaged.
 */
export function parseBedrockOffer(offer: OfferFile): {
  byId: Map<string, Record<string, number>>
  byName: Map<string, Record<string, number>>
  bySlug: Map<string, Record<string, number>>
} {
  const products = offer.products
  const terms = offer.terms?.OnDemand
  if (!products || !terms) {
    throw new Error(
      'amazon-bedrock price list: missing products or OnDemand terms',
    )
  }
  const groups = new Map<string, Group>()
  for (const [sku, product] of Object.entries(products)) {
    const attributes = product.attributes ?? {}
    if (!isStandard(attributes)) continue
    const inferenceType = attributes.inferenceType ?? ''
    const usagetype = attributes.usagetype ?? ''
    const lever = textLever(inferenceType, usagetype)
    const media = isMedia(inferenceType, usagetype)
    if (!lever && !media) continue
    const term = Object.values(terms[sku] ?? {})[0]
    const dimensions = Object.values(term?.priceDimensions ?? {})
    if (dimensions.length !== 1) continue
    const rate = dimensions[0] ? perToken(dimensions[0]) : null
    if (rate === null) continue
    const id = usageModelId(usagetype)
    const name = bedrockNameKey(attributes.model ?? '')
    const slug = bedrockOfferSlug(attributes.model ?? '')
    const key = id ?? (name ? `name:${name}` : '')
    if (!key) continue
    const group = groups.get(key) ?? {
      rates: {},
      media: false,
      conflict: false,
      name: '',
      nameConflict: false,
      slug: '',
      slugConflict: false,
    }
    if (name && group.name && group.name !== name) group.nameConflict = true
    if (name && !group.name) group.name = name
    if (slug && group.slug && group.slug !== slug) group.slugConflict = true
    if (slug && !group.slug) group.slug = slug
    if (media) group.media = true
    if (lever) {
      const prev = group.rates[lever]
      if (prev !== undefined && !close(prev, rate)) group.conflict = true
      group.rates[lever] = rate
    }
    groups.set(key, group)
  }

  const byId = new Map<string, Record<string, number>>()
  const byName = new Map<string, Record<string, number>>()
  const bySlug = new Map<string, Record<string, number>>()
  const dropped = new Set<string>()
  for (const [key, group] of groups) {
    if (group.media || group.conflict || !complete(group.rates)) continue
    // The offer id can be longer (`-instruct`) or punctuated differently
    // (`zai.glm5`, `deepseek.v3.1`) than the card id. The model attribute
    // is the join for those. A longer offer id is never a prefix of the card.
    if (!key.startsWith('name:')) assign(byId, dropped, key, group.rates)
    if (!group.nameConflict && group.name) {
      assign(byName, dropped, group.name, group.rates)
    }
    // `Pixtral Large 25.02` is `pixtral-large-2502` inside the card id.
    // Short slugs (`r1`, `glm-5`) stay off this map so they cannot land
    // on a longer id.
    if (!group.slugConflict && group.slug.length >= 12) {
      assign(bySlug, dropped, group.slug, group.rates)
    }
  }
  const rows = new Map<string, Record<string, number>>([...byId, ...byName])
  assertParsed(rows, 'amazon-bedrock price list')
  return { byId, byName, bySlug }
}

function cellText(cell: string): string {
  return cell
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

function columnLever(header: string, perMillionNote: boolean): string | null {
  const name = header.toLowerCase().replace(/\*/g, '').trim()
  if (/cache/.test(name) && /read/.test(name)) return 'cache_read_tokens'
  if (/cache/.test(name) && /write/.test(name)) return cacheWriteLever(name)
  const priced =
    /price per 1m/.test(name) ||
    (perMillionNote && /^(input|output)$/.test(name))
  if (!priced) return null
  if (/batch|image|video|audio|speech|\(text\)/.test(name)) return null
  if (/output/.test(name)) return OUTPUT
  if (/input/.test(name)) return INPUT
  return null
}

function perMillion(
  cell: string,
  region: Record<string, { price?: string }>,
): number | null {
  const literal = cellText(cell).match(/\$\s*(\d+(?:,\d{3})*(?:\.\d+)?)/)
  if (literal?.[1]) return Number(literal[1].replace(/,/g, ''))
  const code = cell
    .replace(/\s+/g, '')
    .match(
      /\{priceOf!bedrockfoundationmodels\/bedrockfoundationmodels!([A-Za-z0-9_-]+)/,
    )?.[1]
  const price = code ? region[code]?.price : undefined
  if (price === undefined) return null
  const amount = Number(price)
  return Number.isFinite(amount) ? amount : null
}

/**
 * Geo / in-region and plain on-demand tables only. Global, priority,
 * flex, batch, and long-context rows are ignored. Rate codes resolve
 * against US East (N. Virginia); a missing code leaves the cell empty.
 */
export function parseBedrockPricingPage(
  html: string,
  meter: MeterFile,
): Map<string, Record<string, number>> {
  const region = meter.regions?.[USE1]
  if (!region) {
    throw new Error(
      'amazon-bedrock pricing page: no US East (N. Virginia) meter',
    )
  }
  const flat = html.replace(/\{priceOf![\s\S]*?\}/g, (token) =>
    token.replace(/\s+/g, ''),
  )
  const out = new Map<string, Record<string, number>>()
  const dropped = new Set<string>()
  const stack: Array<{ level: number; text: string }> = []
  let pendingLabel = ''
  const token =
    /<h([1-4])[^>]*>([\s\S]*?)<\/h\1>|<div class="lb-txt-none lb-txt">\s*([^<]+?)\s*<\/div>|<table[\s\S]*?<\/table>/gi
  for (const match of flat.matchAll(token)) {
    const level = match[1]
    if (level) {
      const heading = cellText(match[2] ?? '')
      const depth = Number(level)
      while (stack.length > 0 && (stack.at(-1)?.level ?? 0) >= depth)
        stack.pop()
      stack.push({ level: depth, text: heading })
      continue
    }
    const label = match[3]
    if (label) {
      const text = cellText(label)
      if (text && !/pricing|on-demand|^regions/i.test(text)) pendingLabel = text
      continue
    }
    const headings = stack.map((item) => item.text).join(' ')
    if (SKIP_HEADING.test(headings)) continue
    const table = match[0]
    const after = flat.slice(
      match.index + table.length,
      match.index + table.length + 800,
    )
    const perMillionNote = /per 1 million tokens/i.test(`${table}\n${after}`)
    const rows = [...table.matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((row) =>
      [...row[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) =>
        cellText(cell[1] ?? ''),
      ),
    )
    const head = rows[0]
    if (!head) continue
    const levers = head.map((cell) => columnLever(cell, perMillionNote))
    if (!levers.includes(INPUT) || !levers.includes(OUTPUT)) continue
    const ratesOf = (row: Array<string>): Record<string, number> => {
      const rates: Record<string, number> = {}
      row.forEach((cell, index) => {
        const lever = levers[index]
        const amount = perMillion(cell, region)
        if (lever && amount !== null && amount >= 0) rates[lever] = amount / 1e6
      })
      return rates
    }
    // A tab names the model. Rows are tiers. US CRIS is the standard rate.
    if (head.some((cell) => /inference option/i.test(cell))) {
      const chosen = rows.slice(1).find((row) => {
        const tier = row[0] ?? ''
        return /us cris|in-region|regional/i.test(tier) && !/global/i.test(tier)
      })
      const rates = chosen ? ratesOf(chosen) : null
      const key = bedrockNameKey(pendingLabel)
      if (!rates || !key || !complete(rates)) continue
      assign(out, dropped, key, rates)
      continue
    }
    const nameCol = head.findIndex((cell) => /model/i.test(cell))
    const modelCol = nameCol >= 0 ? nameCol : 0
    for (const row of rows.slice(1)) {
      const name = (row[modelCol] ?? '').replace(/\*+/g, '').trim()
      if (!name || /long context/i.test(name)) continue
      const rates = ratesOf(row)
      const key = bedrockNameKey(name)
      if (!key || !complete(rates)) continue
      assign(out, dropped, key, rates)
    }
  }
  assertParsed(out, 'amazon-bedrock pricing page')
  return out
}

/** Longest offer id that is `rawId` or a `-` / `:` boundary prefix of it. */
export function matchBedrockModelId(
  ids: Iterable<string>,
  rawId: string,
): string | null {
  let best: string | null = null
  for (const id of ids) {
    const boundary = rawId.charAt(id.length)
    const hit =
      id === rawId ||
      (rawId.startsWith(id) && (boundary === '-' || boundary === ':'))
    if (hit && (best === null || id.length > best.length)) best = id
  }
  return best
}

/**
 * Longest offer slug inside `rawId`. A following digit continues the
 * version (`250` is not `2502`, `glm-5` is not `glm-5.3`). `-v1` stays.
 */
export function matchBedrockOfferSlug(
  slugs: Iterable<string>,
  rawId: string,
): string | null {
  const id = rawId.toLowerCase()
  let best: string | null = null
  for (const slug of slugs) {
    if (slug.length < 12) continue
    let from = 0
    while (from < id.length) {
      const at = id.indexOf(slug, from)
      if (at < 0) break
      const before = at === 0 ? '' : id.charAt(at - 1)
      const after = id.slice(at + slug.length)
      const boundaryBefore = before === '' || /[^a-z0-9]/.test(before)
      // `250` inside `2502`, or `glm-5` inside `glm-5.3`. `-v1` stays.
      const longerVersion = /^(?:[.-])?\d/.test(after)
      if (
        boundaryBefore &&
        !longerVersion &&
        (best === null || slug.length > best.length)
      ) {
        best = slug
      }
      from = at + 1
    }
  }
  return best
}

export function lookupBedrockPrice(
  book: BedrockPriceBook,
  rawId: string,
  displayName: string | null,
): BedrockPriceHit | null {
  const id = matchBedrockModelId(book.offerById.keys(), rawId)
  if (id) {
    const rates = book.offerById.get(id)
    if (rates)
      return { rates, url: BEDROCK_PRICE_LIST_URL, hash: book.offerHash }
  }
  const name = bedrockNameKey(displayName ?? '')
  if (!name) return null
  const offered = book.offerByName.get(name)
  if (offered) {
    return { rates: offered, url: BEDROCK_PRICE_LIST_URL, hash: book.offerHash }
  }
  const slug = matchBedrockOfferSlug(book.offerBySlug.keys(), rawId)
  if (slug) {
    const rates = book.offerBySlug.get(slug)
    if (rates)
      return { rates, url: BEDROCK_PRICE_LIST_URL, hash: book.offerHash }
  }
  const page = book.pageByName.get(name)
  if (!page) return null
  return { rates: page, url: BEDROCK_PRICING_PAGE_URL, hash: book.pageHash }
}

export async function fetchBedrockPriceBook(): Promise<BedrockPriceBook> {
  const [offerText, html, meterText] = await Promise.all([
    fetchText(BEDROCK_PRICE_LIST_URL, AWS_INIT),
    fetchText(BEDROCK_PRICING_PAGE_URL, AWS_INIT),
    fetchText(BEDROCK_METERED_URL, AWS_INIT),
  ])
  const offer = parseBedrockOffer(JSON.parse(offerText) as OfferFile)
  const page = parseBedrockPricingPage(html, JSON.parse(meterText) as MeterFile)
  return {
    offerById: offer.byId,
    offerByName: offer.byName,
    offerBySlug: offer.bySlug,
    pageByName: page,
    offerHash: await sha256Text(offerText),
    pageHash: await sha256Text(`${html}\n${meterText}`),
  }
}
