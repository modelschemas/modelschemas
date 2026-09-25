/**
 * Mistral prices from the docs pricing page (issue #73). Sections marked
 * "Prices /M Tokens" are standard per-million rates (input, cached input,
 * output). Batch and priority live in other tabs and are not in that table.
 * A cell with a unit ("$4 /1000 Pages", "$0.003 /Min") is not a token rate,
 * so that row gets no card rather than a partial one. "Free" is not a card.
 *
 * The table keys docs slugs (`mistral-large-3-25-12`). The model page names
 * the API ids that slug serves (`mistral-large-2512`, `mistral-large-latest`).
 * An API id named by two slugs at different rates gets no card.
 */
import { compileTokenCard } from '@modelschemas/rate-card'

import { tagDocsFacts } from './fact-sources.ts'
import { assertParsed, cachedDocs, mapConcurrent } from './model-facts.ts'
import { fetchText, sha256Text } from './types.ts'
import type { ModelInfo } from './types.ts'

export const MISTRAL_PRICING_URL = 'https://docs.mistral.ai/inference/pricing'
const MISTRAL_MODEL_PAGE = (slug: string) =>
  `https://docs.mistral.ai/models/${slug}`

export interface MistralTokenRates {
  rates: Record<string, number>
}

function cellText(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

/** `$0.5` per million tokens. `undefined` is an absent lever (`—`). */
function perMillion(cell: string): number | null | undefined {
  if (cell === '—' || cell === '–' || cell === '-' || cell === '') {
    return undefined
  }
  const amount = cell.match(/^\$([\d,]+(?:\.\d+)?)$/)?.[1]
  if (amount === undefined) return null
  return Number(amount.replace(/,/g, '')) / 1e6
}

/**
 * Docs slug → standard token rates. Non-token sections are skipped, and a
 * row whose price is not a plain per-million amount is skipped too.
 */
export function parseMistralPricing(
  html: string,
): Map<string, MistralTokenRates> {
  const out = new Map<string, MistralTokenRates>()
  for (const section of html.split(/<h2\b[^>]*>/i).slice(1)) {
    if (!/Prices\s*\/\s*M Tokens/i.test(section)) continue
    const table = section.match(/<table\b[\s\S]*?<\/table>/i)?.[0] ?? ''
    for (const row of table.matchAll(/<tr\b[\s\S]*?<\/tr>/gi)) {
      const slug = row[0].match(/href="\/models\/([^"]+)"/)?.[1]
      if (!slug || out.has(slug)) continue
      const cells = [...row[0].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(
        ([, cell = '']) => cellText(cell),
      )
      if (cells.some((cell) => /^free$/i.test(cell))) continue
      const input = perMillion(cells[1] ?? '')
      const cached = perMillion(cells[2] ?? '')
      const output = perMillion(cells[3] ?? '')
      if (input === null || cached === null || output === null) continue
      if (input === undefined) continue
      const rates: Record<string, number> = { input_tokens: input }
      if (cached !== undefined) rates.cache_read_tokens = cached
      if (output !== undefined) rates.output_tokens = output
      out.set(slug, { rates })
    }
  }
  return out
}

/**
 * API ids a model page says the slug serves. The payload carries
 * `"names":["mistral-large-2512","mistral-large-latest"]`. When several
 * arrays match, the one sharing the most slug tokens wins; a tie that
 * shares nothing is no mapping.
 */
export function parseMistralApiIds(html: string, slug: string): Array<string> {
  // The page embeds the array as JSON (`"names":["id"]`) and, in the RSC
  // payload, with escaped quotes (`names\":["id"]`).
  const blocks = [
    ...html.matchAll(/"names":\[([^\]]*)\]/g),
    ...html.matchAll(/names\\":\[([^\]]*)\]/g),
  ].flatMap((match) => {
    const body = match[1] ?? ''
    const ids = [
      ...body.matchAll(/"([^"\\]+)"/g),
      ...body.matchAll(/\\"([^"\\]+)\\"/g),
    ].map(([, id = '']) => id)
    return ids.length > 0 &&
      ids.every((id) => /^[a-z0-9][a-z0-9._/-]*$/.test(id))
      ? [ids]
      : []
  })
  if (blocks.length === 0) return []
  const tokens = slug.split('-').filter((token) => token.length > 1)
  const score = (ids: Array<string>) =>
    ids.reduce(
      (total, id) =>
        total + tokens.filter((token) => id.includes(token)).length,
      0,
    )
  const ranked = [...blocks].sort((a, b) => score(b) - score(a))
  const best = ranked[0] ?? []
  const bestScore = score(best)
  if (bestScore === 0 && blocks.length > 1) return []
  return best
}

export interface MistralModelPage {
  slug: string
  ids: Array<string>
  hash: string
}

/**
 * API id → rates. A priced slug with no ids throws: caching a partial map
 * would drop those models' stored cards for the cache TTL.
 */
export function indexMistralApiIds(
  bySlug: Map<string, MistralTokenRates>,
  pages: Array<MistralModelPage>,
): Map<string, MistralTokenRates> {
  const bySlugPage = new Map(pages.map((page) => [page.slug, page]))
  const missing = [...bySlug.keys()].filter(
    (slug) => (bySlugPage.get(slug)?.ids.length ?? 0) === 0,
  )
  if (missing.length > 0) {
    throw new Error(`mistral model pages: no API ids for ${missing.join(', ')}`)
  }
  const byId = new Map<string, MistralTokenRates>()
  const conflicts = new Set<string>()
  for (const page of pages) {
    const rates = bySlug.get(page.slug)
    if (!rates) continue
    const serialized = JSON.stringify(rates.rates)
    for (const id of page.ids) {
      const prior = byId.get(id)
      if (!prior) {
        byId.set(id, rates)
        continue
      }
      if (JSON.stringify(prior.rates) !== serialized) conflicts.add(id)
    }
  }
  for (const id of conflicts) byId.delete(id)
  return byId
}

type PricedFacts = Pick<ModelInfo, 'pricing' | 'factSources'>

/** Card lookup by API model id. */
export async function mistralModelPricing(
  kv?: KVNamespace,
): Promise<(rawId: string) => PricedFacts> {
  const doc = await cachedDocs(kv, MISTRAL_PRICING_URL, async () => {
    const html = await fetchText(MISTRAL_PRICING_URL)
    const bySlug = parseMistralPricing(html)
    assertParsed(bySlug, 'mistral pricing page')
    const pages = await mapConcurrent([...bySlug.keys()], 6, async (slug) => {
      const url = MISTRAL_MODEL_PAGE(slug)
      const page = await cachedDocs(kv, url, async () => {
        const body = await fetchText(url)
        const ids = parseMistralApiIds(body, slug)
        if (ids.length === 0) {
          throw new Error(`mistral model page ${slug}: parsed 0 API ids`)
        }
        return { ids, hash: await sha256Text(body) }
      })
      return { slug, ids: page.ids, hash: page.hash }
    })
    const byId = indexMistralApiIds(bySlug, pages)
    assertParsed(byId, 'mistral model pages')
    const hash = await sha256Text(
      [
        await sha256Text(html),
        ...pages.map((page) => `${page.slug} ${page.hash}`).sort(),
      ].join('\n'),
    )
    return {
      rates: Object.fromEntries(byId),
      hash,
      extractedAt: new Date().toISOString(),
    }
  })
  return (rawId) => {
    const row = doc.rates[rawId]
    const pricing = row
      ? compileTokenCard(row.rates, [], {
          url: MISTRAL_PRICING_URL,
          hash: doc.hash,
          extractedAt: doc.extractedAt,
        })
      : null
    if (!pricing) return {}
    return {
      pricing,
      factSources: tagDocsFacts({ pricing }, MISTRAL_PRICING_URL, doc.hash),
    }
  }
}
