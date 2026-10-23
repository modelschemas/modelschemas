/**
 * Kimi prices from the international pricing page (issue #109). Amounts
 * are USD per 1M tokens (`$0.16 / MTok`; the page states 1 MTok =
 * 1,000,000 tokens). Columns are read by title (issue #484). A row is
 * priced only when every price cell is a bare `$0.16 / MTok`, every title
 * is one this knows, and the row has input, output and cache-hit prices,
 * so a struck or footnoted price leaves the row unpriced rather than
 * shifting the others into its lever. `moonshotModelPricing` throws on a
 * zero-row parse. The tables are read from the HTML page: its `.md`
 * export renders them empty.
 */
import { compileTokenCard } from '@modelschemas/rate-card'

import { parseKimiDocTables } from './kimi-doc-tables.ts'
import type { KimiDocTable } from './kimi-doc-tables.ts'
import { assertParsed, cachedDocs } from './model-facts.ts'
import { fetchText, sha256Text } from './types.ts'
import type { ModelInfo } from './types.ts'

export const MOONSHOT_PRICING_URL = 'https://platform.kimi.ai/docs/pricing/chat'

export interface MoonshotRates {
  input: number
  output: number
  cacheRead: number
  cacheWrite?: number
  cacheWrite1h?: number
}

/** Price column title → the rate it states. */
const PRICE_COLUMNS: Record<string, keyof MoonshotRates> = {
  Input: 'input',
  Output: 'output',
  'Cached Input': 'cacheRead',
  '5m writes': 'cacheWrite',
  '1h writes': 'cacheWrite1h',
}
const ID_COLUMN = 'Model'

/** Model id → USD per million tokens. */
export function parseMoonshotPricing(
  tables: Array<KimiDocTable>,
): Map<string, MoonshotRates> {
  const out = new Map<string, MoonshotRates>()
  for (const { titles, rows } of tables) {
    if (
      titles[0] !== ID_COLUMN ||
      !titles
        .slice(1)
        .every((title) => title !== null && title in PRICE_COLUMNS)
    ) {
      continue
    }
    for (const [id, ...cells] of rows) {
      if (!id?.startsWith('kimi-') || out.has(id)) continue
      const rates: Partial<MoonshotRates> = {}
      cells.forEach((cell, index) => {
        const lever = PRICE_COLUMNS[titles[index + 1] ?? '']
        const amount = cell?.match(/^\$(\d+(?:\.\d+)?) \/ MTok$/)?.[1]
        if (lever && amount !== undefined) rates[lever] = Number(amount)
      })
      const { input, output, cacheRead } = rates
      if (
        cells.length !== titles.length - 1 ||
        Object.keys(rates).length !== cells.length ||
        input === undefined ||
        output === undefined ||
        cacheRead === undefined
      ) {
        continue
      }
      out.set(id, { ...rates, input, output, cacheRead })
    }
  }
  return out
}

type PricedFacts = Pick<ModelInfo, 'pricing'>

export async function moonshotModelPricing(
  kv?: KVNamespace,
): Promise<(rawId: string) => PricedFacts> {
  const doc = await cachedDocs(kv, MOONSHOT_PRICING_URL, async () => {
    const tables = parseKimiDocTables(await fetchText(MOONSHOT_PRICING_URL))
    const parsed = parseMoonshotPricing(tables)
    assertParsed(parsed, 'moonshot pricing page')
    return {
      rates: Object.fromEntries(parsed),
      // The tables, not the page: its HTML changes with every docs deploy.
      hash: await sha256Text(JSON.stringify(tables)),
      extractedAt: new Date().toISOString(),
    }
  })
  return (rawId) => {
    const row = doc.rates[rawId]
    if (!row) return {}
    const rates: Record<string, number> = {
      input_tokens: row.input / 1e6,
      output_tokens: row.output / 1e6,
      cache_read_tokens: row.cacheRead / 1e6,
    }
    if (row.cacheWrite) rates.cache_write_tokens = row.cacheWrite / 1e6
    if (row.cacheWrite1h) rates.cache_write_1h_tokens = row.cacheWrite1h / 1e6
    const pricing = compileTokenCard(rates, [], {
      url: MOONSHOT_PRICING_URL,
      hash: doc.hash,
      extractedAt: doc.extractedAt,
    })
    return pricing ? { pricing } : {}
  }
}
