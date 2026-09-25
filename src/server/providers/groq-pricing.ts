/**
 * Groq prices from GroqCloud's supported-models page (issue #73). The
 * markdown mirror is one table per lifecycle (production, preview) whose
 * price cell is `$0.15 input$0.60 output`, `$0.111 per hour`, or
 * `$40.00 per 1M characters`. "Contact Sales" publishes no number, so that
 * row gets no card. A price cell in any other shape refuses that model
 * rather than quoting part of it. A page that prices nothing throws.
 */
import { compileTokenCard, compileUnitCard } from '@modelschemas/rate-card'
import type { UnitCardSpec } from '@modelschemas/rate-card'

import { tagDocsFacts } from './fact-sources.ts'
import { assertParsed, cachedDocs, markdownTableRows } from './model-facts.ts'
import { fetchText, sha256Text } from './types.ts'
import type { ModelInfo } from './types.ts'

export const GROQ_PRICING_URL = 'https://console.groq.com/docs/models.md'

export type GroqPrice =
  | { kind: 'tokens'; rates: Record<string, number> }
  | { kind: 'unit'; unit: UnitCardSpec }

/** API id glued on after the docs link. `Enterprise` is a badge, not the id. */
export function groqModelId(cell: string): string | null {
  // The cell leads with an image link; the model id follows the docs link.
  const matches = [
    ...cell.matchAll(/\]\([^)]+\)([A-Za-z0-9][A-Za-z0-9./_-]*)/g),
  ]
  const id = matches.at(-1)?.[1]?.replace(/^Enterprise(?=[a-z0-9])/, '')
  return id && id.length > 0 ? id : null
}

/**
 * One price cell. `null` skips a row with no public price. A cell that
 * quotes `$` in a shape this does not know refuses the model (`'refuse'`).
 */
export function parseGroqPrice(cell: string): GroqPrice | null | 'refuse' {
  const text = cell.replace(/\\/g, '').replace(/\s+/g, '')
  if (text === '' || text === '-' || /^contactsales$/i.test(text)) {
    return null
  }
  const tokens = text.match(/^\$(\d+(?:\.\d+)?)input\$(\d+(?:\.\d+)?)output$/)
  if (tokens?.[1] && tokens[2]) {
    return {
      kind: 'tokens',
      rates: {
        input_tokens: Number(tokens[1]) / 1e6,
        output_tokens: Number(tokens[2]) / 1e6,
      },
    }
  }
  const hour = text.match(/^\$(\d+(?:\.\d+)?)perhour$/)
  if (hour?.[1]) {
    return {
      kind: 'unit',
      unit: {
        quantity: { param: 'audio_seconds', bound: 'usage' },
        rates: Number(hour[1]) / 3600,
      },
    }
  }
  const characters = text.match(/^\$(\d+(?:\.\d+)?)per1Mcharacters$/)
  if (characters?.[1]) {
    return {
      kind: 'unit',
      unit: {
        quantity: { param: 'characters', bound: 'usage' },
        rates: Number(characters[1]) / 1e6,
      },
    }
  }
  return text.includes('$') ? 'refuse' : null
}

/** Model id → the price the models page states. Refused rows are absent. */
export function parseGroqPricing(markdown: string): Map<string, GroqPrice> {
  const out = new Map<string, GroqPrice>()
  for (const cells of markdownTableRows(markdown)) {
    const id = groqModelId(cells[0] ?? '')
    const price = parseGroqPrice(cells[2] ?? '')
    if (!id || price === null || price === 'refuse' || out.has(id)) continue
    out.set(id, price)
  }
  return out
}

type PricedFacts = Pick<ModelInfo, 'pricing' | 'factSources'>

/** Card lookup by listed model id. */
export async function groqModelPricing(
  kv?: KVNamespace,
): Promise<(rawId: string) => PricedFacts> {
  const doc = await cachedDocs(kv, GROQ_PRICING_URL, async () => {
    const markdown = await fetchText(GROQ_PRICING_URL)
    const parsed = parseGroqPricing(markdown)
    assertParsed(parsed, 'groq models page')
    return {
      rates: Object.fromEntries(parsed),
      hash: await sha256Text(markdown),
      extractedAt: new Date().toISOString(),
    }
  })
  return (rawId) => {
    const row = doc.rates[rawId]
    if (!row) return {}
    const source = {
      url: GROQ_PRICING_URL,
      hash: doc.hash,
      extractedAt: doc.extractedAt,
    }
    const pricing =
      row.kind === 'unit'
        ? compileUnitCard(row.unit, source)
        : compileTokenCard(row.rates, [], source)
    if (!pricing) return {}
    return {
      pricing,
      factSources: tagDocsFacts({ pricing }, GROQ_PRICING_URL, doc.hash),
    }
  }
}
