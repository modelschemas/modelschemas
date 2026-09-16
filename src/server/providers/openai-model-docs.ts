/**
 * OpenAI model facts from OpenAI's own docs. `GET /v1/models` is `id` +
 * `created` only; developers.openai.com serves every model page as
 * markdown (`/api/docs/models/{slug}.md`) with a fixed "Model details"
 * bullet list, a "Supported features" list, and the page's snapshot ids. The index (`/api/docs/models.md`) is the
 * slug list. Only pages the listed ids resolve to are fetched (~65 of the
 * ~130 listed ids share a page), bounded-concurrency, memoised six hours.
 */
import { compileTokenCard, compileUnitCard } from '@modelschemas/rate-card'
import type { TokenRateTier, UnitCardSpec } from '@modelschemas/rate-card'

import { tagDocsFacts } from './fact-sources.ts'
import {
  NO_FACTS,
  assertParsed,
  cachedDocs,
  mapConcurrent,
  markdownSection,
  markdownTableRows,
  parseDay,
  tokenCount,
  undatedId,
} from './model-facts.ts'
import type { ModelFacts } from './model-facts.ts'
import { fetchText, sha256Text } from './types.ts'

export const OPENAI_MODELS_INDEX_URL =
  'https://developers.openai.com/api/docs/models.md'
const OPENAI_MODEL_PAGE = (slug: string) =>
  `https://developers.openai.com/api/docs/models/${slug}.md`

/** Page slugs linked from the models index. */
export function parseModelIndex(markdown: string): Set<string> {
  return new Set(
    [
      ...markdown.matchAll(/\]\(\/api\/docs\/models\/([^)\s]+?)\.md\)/g),
    ].flatMap((m) => (m[1] ? [m[1]] : [])),
  )
}

export interface OpenAiModelPage {
  /** Every id the page speaks for: `Model ID`, default snapshot, snapshots. */
  ids: Array<string>
  facts: ModelFacts
  /** Token rates and tiers, or null when the page prices otherwise. */
  pricing: DocsPricing | null
}

/**
 * Pricing subsection → the lever each `Metric` row prices. Every other
 * subsection (image/video generation, audio duration, a per-call tool fee)
 * refuses the whole model: a card quoting only its token rows would
 * understate the bill. Unknown means null, never a partial card.
 */
const PRICING_LEVERS: Record<string, Record<string, string>> = {
  'Text tokens': {
    Input: 'input_tokens',
    'Cached input': 'cache_read_tokens',
    'Cache writes': 'cache_write_tokens',
    Output: 'output_tokens',
  },
  'Audio tokens': {
    Input: 'audio_tokens',
    'Cached input': 'audio_cache_tokens',
    Output: 'audio_output_tokens',
  },
  'Image tokens': {
    Input: 'image_tokens',
    'Cached input': 'image_cache_tokens',
    Output: 'image_output_tokens',
  },
  Embeddings: { Cost: 'input_tokens' },
}

/**
 * Sections priced per unit rather than per token. `Pricing` is the legacy
 * tts/whisper table, whose `Cost` row carries the unit.
 */
const UNIT_SECTIONS = new Set([
  'Realtime audio duration',
  'Transcription audio duration',
  'Live session duration',
  'Video generation',
  'Pricing',
])

/**
 * Sections that restate a token price per unit rather than adding a cost.
 * OpenAI's image models bill by tokens ("Prices per 1M tokens" on the
 * pricing page); the per-image table is the equivalent cost of one image at
 * a quality and size, already covered by the Image tokens rows.
 */
const DERIVED_SECTIONS = new Set(['Image generation'])

const DAY_MS = 86_400_000

/** `$1.25` → 1.25; null for anything that is not a plain dollar amount. */
function usd(cell: string | undefined): number | null {
  const amount = cell?.match(/^\$([\d,]+(?:\.\d+)?)$/)?.[1]
  return amount === undefined ? null : Number(amount.replace(/,/g, ''))
}

/**
 * Prose under the tables that changes the price. A bullet naming a
 * non-default service tier, an opt-in endpoint or nothing billable is
 * prose; anything else that quotes a multiplier or an amount refuses the
 * model, so a new kind of surcharge cannot slip past as prose.
 */
const PROSE_BULLETS =
  /\bbatch\b|\bflex\b|fast mode|priority|regional processing|data residency|calculator|does not offer|not billed|rather than text tokens|token rates match/i

/** Levers a "…x input and cache rates" multiplier re-quotes. */
const INPUT_LEVERS = [
  'input_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
  'image_tokens',
  'image_cache_tokens',
  'audio_tokens',
  'audio_cache_tokens',
]
const OUTPUT_LEVERS = [
  'output_tokens',
  'image_output_tokens',
  'audio_output_tokens',
]

export interface DocsPricing {
  rates: Record<string, number>
  tiers: Array<TokenRateTier>
  /** Promo end the page names, as an ISO instant. */
  expiresAt?: string
  /** Set instead of `rates` when the model is billed per unit. */
  unit?: UnitCardSpec
}

/** Unit a price is quoted in → the lever it bills, and units per quote. */
const UNITS: Record<string, { param: string; per: number }> = {
  minute: { param: 'audio_seconds', per: 60 },
  second: { param: 'seconds', per: 1 },
  '1M characters': { param: 'characters', per: 1e6 },
}

/**
 * A per-unit section: one rate, or one per output size. The metric cell of
 * a video row names the sizes the rate covers ("Portrait: 720x1280
 * Landscape: 1280x720"), which are `size` values on the request.
 */
function parseUnitSection(block: string): UnitCardSpec | null {
  const rates: Record<string, number> = {}
  let flat: number | null = null
  let unit: { param: string; per: number } | undefined
  for (const [metric = '', price, cell] of markdownTableRows(block)) {
    if (metric === 'Metric') continue
    const rate = usd(price)
    const found = cell === undefined ? undefined : UNITS[cell]
    // "Use case | Speech generation | 1M tokens" labels the table, and a
    // row this parser cannot price at all refuses the model.
    if (rate === null) {
      if (metric === 'Use case' || metric === 'Quality') continue
      return null
    }
    if (!found) return null
    if (unit && unit.param !== found.param) return null
    unit = found
    const sizes = [...metric.matchAll(/(\d{3,4}x\d{3,4})/g)].map(
      ([size]) => size,
    )
    if (sizes.length === 0) {
      if (flat !== null) return null
      flat = rate / found.per
      continue
    }
    for (const size of sizes) rates[size] = rate / found.per
  }
  if (!unit) return null
  const sized = Object.keys(rates).length > 0
  if (sized && flat !== null) return null
  if (!sized && flat === null) return null
  // Duration and characters are measured after the call; a video's length
  // and size are fields of the request that asked for it.
  const bound = unit.param === 'seconds' ? 'request' : 'usage'
  return {
    quantity: { param: unit.param, bound },
    ...(sized && {
      keys: [{ param: 'size', values: Object.keys(rates) }],
    }),
    rates: sized ? rates : (flat ?? 0),
  }
}

/**
 * Per-token rates, long-prompt tiers and promo end from a model page's
 * `## Pricing` section.
 */
export function parseModelPricing(markdown: string): DocsPricing | null {
  const pricing = markdownSection(markdown, 'Pricing')
  const rates: Record<string, number> = {}
  const blocks = pricing.split('\n### ').slice(1)
  for (const block of blocks) {
    const heading = block.split('\n')[0]?.trim() ?? ''
    if (DERIVED_SECTIONS.has(heading)) continue
    if (UNIT_SECTIONS.has(heading)) {
      // A model is billed one way: a page mixing token tables with a
      // per-unit one is a shape this parser does not know.
      if (blocks.length !== 1) return null
      const unit = parseUnitSection(block)
      return unit ? { rates: {}, tiers: [], unit } : null
    }
    const levers = PRICING_LEVERS[heading]
    if (!levers) return null
    for (const [metric = '', price, unit] of markdownTableRows(block)) {
      if (metric === 'Metric') continue
      const lever = levers[metric]
      const rate = usd(price)
      if (!lever || rate === null || unit !== '1M tokens') return null
      rates[lever] = rate / 1e6
    }
  }
  if (Object.keys(rates).length === 0) return null

  const bullets = [...pricing.matchAll(/^- (.+)$/gm)].map(
    ([, bullet = '']) => bullet,
  )
  const out: DocsPricing = { rates, tiers: [] }

  // Rate-adding bullets first: a tier re-quotes whatever levers exist.
  for (const bullet of bullets) {
    // "Cache writes are billed at 1.25x the uncached input token rate."
    const cacheWrite = bullet.match(
      /cache writes are billed at ([\d.]+)x the uncached input token rate/i,
    )
    const input = rates.input_tokens
    if (
      cacheWrite?.[1] &&
      input !== undefined &&
      !('cache_write_tokens' in rates)
    ) {
      rates.cache_write_tokens = input * Number(cacheWrite[1])
    }
    // "…promotional pricing is available at least through November 21, 2026."
    const promo = bullet.match(
      /promotional pricing[^.]*through ([a-z]+ \d{1,2}, \d{4})/i,
    )
    if (promo?.[1]) {
      const day = parseDay(promo[1])
      if (day === null) return null
      out.expiresAt = new Date(day + DAY_MS).toISOString()
    }
  }

  for (const bullet of bullets) {
    if (/cache writes are billed at|promotional pricing/i.test(bullet)) continue
    // "Prompts with >272K input tokens are priced at 2x input and 1.5x
    // output for the full request" — a whole-request re-quote of every
    // rate, which is exactly a tier.
    const long = bullet.match(
      /prompts with (?:more than |>)([\d,.]+\s*[km]?) input tokens are priced at ([\d.]+)x input(?: and cache rates)? and ([\d.]+)x output/i,
    )
    if (long) {
      const threshold = tokenCount(long[1])
      if (threshold === null) return null
      const tier: Record<string, number> = {}
      for (const [lever, rate] of Object.entries(rates)) {
        const factor = INPUT_LEVERS.includes(lever)
          ? Number(long[2])
          : OUTPUT_LEVERS.includes(lever)
            ? Number(long[3])
            : null
        // A lever the sentence does not cover would be quoted at the base
        // rate inside the tier, which is a guess.
        if (factor === null) return null
        tier[lever] = rate * factor
      }
      out.tiers.push({ minPromptTokens: threshold, rates: tier })
      continue
    }
    if (PROSE_BULLETS.test(bullet)) continue
    // An unrecognised bullet that quotes money, a multiplier or a
    // percentage may be a surcharge this card would drop.
    if (/\$|\b\d+(\.\d+)?x\b|%/.test(bullet)) return null
  }
  return out
}

function listValues(block: string, label: string): Array<string> {
  const match = block.match(new RegExp(`^- ${label}: (.+)$`, 'm'))
  return match?.[1]
    ? match[1].split(',').map((s) => s.trim().toLowerCase())
    : []
}

/** Parse one model page's details, features and snapshot ids. */
export function parseModelPage(markdown: string): OpenAiModelPage | null {
  const modelId = markdown.match(/^Model ID: `([^`]+)`/m)?.[1]
  if (!modelId) return null
  const details = markdownSection(markdown, 'Model details')
  const ids = new Set<string>([modelId])
  const snapshot = details.match(/^- Default snapshot: `([^`]+)`/m)?.[1]
  if (snapshot) ids.add(snapshot)
  for (const m of markdownSection(markdown, 'Snapshots').matchAll(
    /^- `([^`]+)`/gm,
  )) {
    if (m[1]) ids.add(m[1])
  }

  const input = listValues(details, 'Input modalities')
  const output = listValues(details, 'Output modalities')
  const contextWindow = tokenCount(
    details.match(/^- ([\d,]+) context window/m)?.[1],
  )
  const maxOutput = tokenCount(
    details.match(/^- ([\d,]+) max output tokens/m)?.[1],
  )

  const features = new Set(
    [
      ...markdownSection(markdown, 'Supported features').matchAll(/^- (\S+)/gm),
    ].map((m) => m[1] ?? ''),
  )
  const reasoning = /^- Reasoning token support/m.test(details)
  const capabilities: Array<string> = []
  if (features.has('function_calling')) capabilities.push('tools')
  if (reasoning) capabilities.push('reasoning')
  // Effort levels and sampling-param support appear only in prose on the
  // page; neither is a field, so neither is asserted here.
  if (features.has('structured_outputs')) {
    capabilities.push('structured_outputs', 'response_format')
  }

  return {
    ids: [...ids],
    pricing: parseModelPricing(markdown),
    facts: {
      contextWindow,
      maxOutput,
      modalities:
        input.length > 0 || output.length > 0 ? { input, output } : null,
      capabilities: capabilities.length > 0 ? capabilities : null,
    },
  }
}

/** Page slug a listed id resolves to, or null when the docs have no page. */
export function pageSlugFor(rawId: string, slugs: Set<string>): string | null {
  if (slugs.has(rawId)) return rawId
  const undated = undatedId(rawId)
  if (slugs.has(undated)) return undated
  return null
}

/**
 * Facts for the listed ids. Pages are fetched once per slug and memoised;
 * a page's snapshot list also seeds ids the index alone couldn't resolve.
 */
export async function openaiModelFacts(
  rawIds: Array<string>,
  kv?: KVNamespace,
): Promise<(rawId: string) => ModelFacts> {
  const slugs = new Set(
    await cachedDocs(kv, OPENAI_MODELS_INDEX_URL, async () => {
      const parsed = [
        ...parseModelIndex(await fetchText(OPENAI_MODELS_INDEX_URL)),
      ]
      if (parsed.length === 0) {
        throw new Error('openai models index: parsed 0 page slugs')
      }
      return parsed
    }),
  )
  const needed = [
    ...new Set(
      rawIds
        .map((id) => pageSlugFor(id, slugs))
        .filter((slug): slug is string => slug !== null),
    ),
  ]
  const pages = await mapConcurrent(needed, 8, async (slug) => {
    try {
      const page = await cachedDocs(kv, OPENAI_MODEL_PAGE(slug), async () => {
        const markdown = await fetchText(OPENAI_MODEL_PAGE(slug))
        const parsed = parseModelPage(markdown)
        if (!parsed) {
          throw new Error(`openai model page ${slug}: no Model ID`)
        }
        // The card's provenance hashes the page as served, so an unchanged
        // page keeps the stored card (and its `extractedAt`) on re-parse.
        return {
          ...parsed,
          hash: await sha256Text(markdown),
          extractedAt: new Date().toISOString(),
        }
      })
      return { slug, page }
    } catch {
      return null
    }
  })
  const byId = new Map<string, ModelFacts>()
  for (const loaded of pages) {
    if (!loaded) continue
    const url = OPENAI_MODEL_PAGE(loaded.slug)
    const withPricing: ModelFacts = {
      ...loaded.page.facts,
      pricing: loaded.page.pricing?.unit
        ? compileUnitCard(loaded.page.pricing.unit, {
            url,
            hash: loaded.page.hash,
            extractedAt: loaded.page.extractedAt,
          })
        : loaded.page.pricing
          ? compileTokenCard(
              loaded.page.pricing.rates,
              loaded.page.pricing.tiers,
              {
                url,
                hash: loaded.page.hash,
                extractedAt: loaded.page.extractedAt,
                ...(loaded.page.pricing.expiresAt && {
                  expiresAt: loaded.page.pricing.expiresAt,
                }),
              },
            )
          : null,
    }
    const facts: ModelFacts = {
      ...withPricing,
      factSources: tagDocsFacts(withPricing, url, loaded.page.hash),
    }
    for (const id of loaded.page.ids) byId.set(id, facts)
  }
  if (needed.length > 0) assertParsed(byId, 'openai model pages')
  return (rawId) => byId.get(rawId) ?? byId.get(undatedId(rawId)) ?? NO_FACTS
}
