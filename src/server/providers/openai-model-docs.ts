/**
 * OpenAI model facts from OpenAI's own docs. `GET /v1/models` is `id` +
 * `created` only; developers.openai.com serves every model page as
 * markdown (`/api/docs/models/{slug}.md`) with a fixed "Model details"
 * bullet list, a "Supported features" list, and the page's snapshot ids. The index (`/api/docs/models.md`) is the
 * slug list. Only pages the listed ids resolve to are fetched (~65 of the
 * ~130 listed ids share a page), bounded-concurrency, memoised six hours.
 */
import { compileTokenCard } from '@modelschemas/rate-card'

import { tagDocsFacts } from './fact-sources.ts'
import {
  NO_FACTS,
  assertParsed,
  cachedDocs,
  mapConcurrent,
  markdownSection,
  markdownTableRows,
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
  /** Per-token USD rates by lever, or null when the page prices otherwise. */
  rates: Record<string, number> | null
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

/** `$1.25` → 1.25; null for anything that is not a plain dollar amount. */
function usd(cell: string | undefined): number | null {
  const amount = cell?.match(/^\$([\d,]+(?:\.\d+)?)$/)?.[1]
  return amount === undefined ? null : Number(amount.replace(/,/g, ''))
}

/** Per-token rates from a model page's `## Pricing` tables. */
export function parsePricingRates(
  markdown: string,
): Record<string, number> | null {
  const rates: Record<string, number> = {}
  for (const block of markdownSection(markdown, 'Pricing')
    .split('\n### ')
    .slice(1)) {
    const levers = PRICING_LEVERS[block.split('\n')[0]?.trim() ?? '']
    if (!levers) return null
    for (const [metric = '', price, unit] of markdownTableRows(block)) {
      if (metric === 'Metric') continue
      const lever = levers[metric]
      const rate = usd(price)
      if (!lever || rate === null || unit !== '1M tokens') return null
      rates[lever] = rate / 1e6
    }
  }
  return Object.keys(rates).length > 0 ? rates : null
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
    rates: parsePricingRates(markdown),
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
      pricing: loaded.page.rates
        ? compileTokenCard(loaded.page.rates, [], {
            url,
            hash: loaded.page.hash,
            extractedAt: loaded.page.extractedAt,
          })
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
