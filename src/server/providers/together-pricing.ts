/**
 * Together image, video, and audio prices from the serverless catalog
 * (issue #115). Chat token rates stay on the models listing. A per-image
 * cell marked as varying is the provider’s pass-through estimate, not a
 * rate, so it stays null. Video rows that name a clip length are per
 * second (price ÷ seconds). A video price with no length is the catalog’s
 * per-video figure. All-zero and unpublished rows stay null.
 */
import { compileUnitCard } from '@modelschemas/rate-card'
import type { RateCard, UnitCardSpec } from '@modelschemas/rate-card'

import { tagDocsFacts } from './fact-sources.ts'
import {
  assertParsed,
  cachedDocs,
  markdownSection,
  markdownTableRows,
} from './model-facts.ts'
import { fetchText, sha256Text } from './types.ts'
import type { ModelInfo } from './types.ts'

export const TOGETHER_MODELS_DOCS_URL =
  'https://docs.together.ai/docs/serverless/models.md'

const MEDIA_ACTIVITIES = new Set(['image', 'video', 'audio'])

function clean(cell: string): string {
  return cell.replace(/\\/g, '').replace(/`/g, '').replace(/\s+/g, ' ').trim()
}

function modelId(cell: string): string | null {
  const id = clean(cell)
  return /^[A-Za-z0-9][\w.+-]*\/[\w.+-]+$/.test(id) ? id : null
}

/** Leading dollar amount. `null` when the cell is not a single rate. */
function fixedDollars(cell: string): number | null {
  const text = clean(cell)
  if (text === '' || text === '-' || /varies|\+/i.test(text)) return null
  const amounts = [...text.matchAll(/\$(\d+(?:\.\d+)?)/g)]
  if (amounts.length !== 1 || !amounts[0]?.[1]) return null
  const amount = Number(amounts[0][1])
  return Number.isFinite(amount) && amount > 0 ? amount : null
}

function put(
  out: Map<string, UnitCardSpec>,
  id: string | null,
  spec: UnitCardSpec | null,
): void {
  if (!id || !spec || out.has(id.toLowerCase())) return
  out.set(id.toLowerCase(), spec)
}

function imageSpec(unitCell: string, priceCell: string): UnitCardSpec | null {
  const amount = fixedDollars(priceCell)
  if (amount === null) return null
  const unit = clean(unitCell).toLowerCase()
  if (unit === 'megapixel') {
    return {
      quantity: { param: 'megapixels', bound: 'usage' },
      rates: amount,
    }
  }
  if (unit === 'image') {
    return {
      quantity: { param: 'images', bound: 'usage' },
      rates: amount,
    }
  }
  return null
}

function videoSpec(priceCell: string, detailCell: string): UnitCardSpec | null {
  const amount = fixedDollars(priceCell)
  if (amount === null) return null
  const seconds = clean(detailCell).match(/(\d+)\s*s\b/i)?.[1]
  if (!seconds) return { rates: amount }
  return {
    quantity: { param: 'seconds', bound: 'usage' },
    rates: amount / Number(seconds),
  }
}

function audioSpec(priceCell: string): UnitCardSpec | null {
  const text = clean(priceCell)
  const amount = fixedDollars(priceCell)
  if (amount === null) return null
  if (/per 1M chars/i.test(text)) {
    return {
      quantity: { param: 'characters', bound: 'usage' },
      rates: amount / 1e6,
    }
  }
  if (/per audio min/i.test(text)) {
    return {
      quantity: { param: 'audio_seconds', bound: 'usage' },
      rates: amount / 60,
    }
  }
  return null
}

/** Model id (lowercase) → unit sheet. Ids the catalog does not rate are absent. */
export function parseTogetherMediaPrices(
  markdown: string,
): Map<string, UnitCardSpec> {
  const out = new Map<string, UnitCardSpec>()
  for (const cells of markdownTableRows(
    markdownSection(markdown, 'Image models'),
  )) {
    put(out, modelId(cells[2] ?? ''), imageSpec(cells[3] ?? '', cells[4] ?? ''))
  }
  for (const cells of markdownTableRows(
    markdownSection(markdown, 'Video models'),
  )) {
    put(out, modelId(cells[2] ?? ''), videoSpec(cells[3] ?? '', cells[4] ?? ''))
  }
  for (const cells of markdownTableRows(
    markdownSection(markdown, 'Audio models'),
  )) {
    put(out, modelId(cells[3] ?? ''), audioSpec(cells[4] ?? ''))
  }
  return out
}

/** The unit card `listModels` stores. `null` when the sheet is not a price. */
export function togetherMediaCard(
  spec: UnitCardSpec,
  source: RateCard['source'],
): RateCard | null {
  return compileUnitCard(spec, source)
}

type PricedFacts = Pick<ModelInfo, 'pricing' | 'factSources'>

/** Card lookup for image, video, and audio ids. Chat ids are not in the map. */
export async function togetherMediaPricing(
  kv?: KVNamespace,
): Promise<(rawId: string, activity: string | null) => PricedFacts> {
  const doc = await cachedDocs(kv, TOGETHER_MODELS_DOCS_URL, async () => {
    const markdown = await fetchText(TOGETHER_MODELS_DOCS_URL)
    const parsed = parseTogetherMediaPrices(markdown)
    assertParsed(parsed, 'together models catalog')
    return {
      rates: Object.fromEntries(parsed),
      hash: await sha256Text(markdown),
      extractedAt: new Date().toISOString(),
    }
  })
  return (rawId, activity) => {
    if (!activity || !MEDIA_ACTIVITIES.has(activity)) return {}
    const spec = doc.rates[rawId.toLowerCase()]
    if (!spec) return {}
    const source = {
      url: TOGETHER_MODELS_DOCS_URL,
      hash: doc.hash,
      extractedAt: doc.extractedAt,
    }
    const pricing = togetherMediaCard(spec, source)
    if (!pricing) return {}
    return {
      pricing,
      factSources: tagDocsFacts(
        { pricing },
        TOGETHER_MODELS_DOCS_URL,
        doc.hash,
      ),
    }
  }
}
