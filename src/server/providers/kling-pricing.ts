/**
 * Kling list prices from https://kling.ai/dev/pricing (issue #122). The
 * page embeds an English price table as JSON. A single dollar amount
 * becomes a card. Two different amounts for one catalog id, or a model
 * the table does not name, stays unpriced. 4K is not a `mode` value
 * (`std` is 720p, `pro` is 1080p), so it is not a key on the card.
 */
import { compileUnitCard } from '@modelschemas/rate-card'
import type { UnitCardSpec } from '@modelschemas/rate-card'

import { tagDocsFacts } from './fact-sources.ts'
import { assertParsed, cachedDocs } from './model-facts.ts'
import { fetchText, sha256Text } from './types.ts'
import type { ModelInfo } from './types.ts'

export const KLING_PRICING_URL = 'https://kling.ai/dev/pricing'

/** Display name on the pricing page → catalog raw id, when that is 1:1. */
const CATALOG_IDS: Record<string, string> = {
  'Kling Image O1': 'kling-image-o1',
  'Kling 3.0': 'kling-v3',
}

const DOLLARS = /\$(\d+(?:\.\d+)?)\)/

interface ImageRow {
  model?: string
  price?: string | Array<string>
}

interface VideoRow {
  model?: string
  spec?: string
  function?: string | Array<string>
  p720?: string | Array<string>
  p1080?: string | Array<string>
}

interface KlingPage {
  en?: {
    newImageApi?: {
      main?: { list?: Array<{ table?: { data?: Array<ImageRow> } }> }
    }
    newVideoApi?: {
      main?: { list?: Array<{ table?: { data?: Array<VideoRow> } }> }
    }
  }
}

function dollars(cell: string | undefined): number | null {
  const match = cell?.match(DOLLARS)?.[1]
  return match === undefined ? null : Number(match)
}

function asList(value: string | Array<string> | undefined): Array<string> {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

/** One shared per-image price, or null when the row quotes more than one. */
function imageRate(row: ImageRow): number | null {
  const amounts = asList(row.price)
    .map((cell) => dollars(cell))
    .filter((amount): amount is number => amount !== null)
  if (amounts.length === 0) return null
  return amounts.every((amount) => amount === amounts[0])
    ? (amounts[0] ?? null)
    : null
}

/**
 * `mode` × `sound` per-second rates. Null unless both published features
 * have a 720p and a 1080p dollar amount and no further feature is priced.
 */
function videoSpec(row: VideoRow): UnitCardSpec | null {
  if (row.spec !== 'Per second') return null
  const features = asList(row.function)
  const p720 = asList(row.p720)
  const p1080 = asList(row.p1080)
  if (features.length !== 2 || p720.length !== 2 || p1080.length !== 2) {
    return null
  }
  const rates: Partial<Record<'off' | 'on', { std: number; pro: number }>> = {}
  for (const [index, feature] of features.entries()) {
    const sound =
      feature === 'No Native Audio'
        ? 'off'
        : feature === 'With Native Audio x No Voice Control'
          ? 'on'
          : null
    const std = dollars(p720[index])
    const pro = dollars(p1080[index])
    if (sound === null || std === null || pro === null) return null
    rates[sound] = { std, pro }
  }
  const off = rates.off
  const on = rates.on
  if (!off || !on) return null
  return {
    quantity: { param: 'duration', bound: 'request' },
    keys: [
      { param: 'sound', values: ['off', 'on'], default: 'off' },
      { param: 'mode', values: ['std', 'pro'], default: 'std' },
    ],
    rates: {
      off: { std: off.std, pro: off.pro },
      on: { std: on.std, pro: on.pro },
    },
  }
}

function pageJson(text: string): KlingPage | null {
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) {
    return JSON.parse(trimmed) as KlingPage
  }
  const marker = text.indexOf('devModelPageInfo')
  const brace = marker < 0 ? -1 : text.indexOf('{', marker)
  if (brace < 0) return null
  let depth = 0
  for (let index = brace; index < text.length; index++) {
    const char = text[index]
    if (char === '{') depth++
    else if (char === '}') {
      depth--
      if (depth === 0) {
        return JSON.parse(text.slice(brace, index + 1)) as KlingPage
      }
    }
  }
  return null
}

/** Catalog id → unit sheet. Ids the page does not price once are absent. */
export function parseKlingPricing(page: string): Map<string, UnitCardSpec> {
  const parsed = pageJson(page)
  const out = new Map<string, UnitCardSpec>()
  const images =
    parsed?.en?.newImageApi?.main?.list?.flatMap(
      (block) => block.table?.data ?? [],
    ) ?? []
  for (const row of images) {
    const id = row.model ? CATALOG_IDS[row.model] : undefined
    const rate = imageRate(row)
    if (!id || rate === null || out.has(id)) continue
    out.set(id, {
      quantity: { param: 'n', bound: 'request', default: 1 },
      rates: rate,
    })
  }
  const videos =
    parsed?.en?.newVideoApi?.main?.list?.flatMap(
      (block) => block.table?.data ?? [],
    ) ?? []
  for (const row of videos) {
    const id = row.model ? CATALOG_IDS[row.model] : undefined
    const spec = videoSpec(row)
    if (!id || !spec || out.has(id)) continue
    out.set(id, spec)
  }
  return out
}

type PricedFacts = Pick<ModelInfo, 'pricing' | 'factSources'>

/** Card lookup by listed model id. */
export async function klingModelPricing(
  kv?: KVNamespace,
): Promise<(rawId: string) => PricedFacts> {
  const doc = await cachedDocs(kv, KLING_PRICING_URL, async () => {
    const page = await fetchText(KLING_PRICING_URL)
    const parsed = parseKlingPricing(page)
    assertParsed(parsed, 'kling pricing page')
    return {
      rates: Object.fromEntries(parsed),
      hash: await sha256Text(page),
      extractedAt: new Date().toISOString(),
    }
  })
  return (rawId) => {
    const row = doc.rates[rawId]
    if (!row) return {}
    const pricing = compileUnitCard(row, {
      url: KLING_PRICING_URL,
      hash: doc.hash,
      extractedAt: doc.extractedAt,
    })
    if (!pricing) return {}
    return {
      pricing,
      factSources: tagDocsFacts({ pricing }, KLING_PRICING_URL, doc.hash),
    }
  }
}
