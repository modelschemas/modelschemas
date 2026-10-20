/**
 * Kimi prices from the international pricing page (issue #109). Amounts
 * are USD per 1M tokens. K2 rows are cache-hit / cache-miss / output.
 * K3 rows add cache-write TTLs, by position. A row is priced only when
 * every cell between its unit and its context window is a bare `$0.16`,
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

/** The amounts, or null when any cell is not a bare dollar amount. */
function dollars(cells: Array<string | null>): Array<number> | null {
  const amounts = cells.map((cell) => cell?.match(/^\$(\d+(?:\.\d+)?)$/)?.[1])
  return amounts.every((amount) => amount !== undefined)
    ? amounts.map(Number)
    : null
}

/** Model id → USD per million tokens. */
export function parseMoonshotPricing(
  tables: Array<KimiDocTable>,
): Map<string, MoonshotRates> {
  const out = new Map<string, MoonshotRates>()
  for (const [id, unit, ...cells] of tables.flatMap((table) => table.rows)) {
    const context = /^[\d,]+ tokens$/.test(cells.at(-1) ?? '')
    const amounts = dollars(context ? cells.slice(0, -1) : cells)
    if (
      !id?.startsWith('kimi-') ||
      unit !== '1M tokens' ||
      out.has(id) ||
      amounts === null
    ) {
      continue
    }
    if (amounts.length === 3) {
      const [cacheRead, input, output] = amounts
      if (
        cacheRead === undefined ||
        input === undefined ||
        output === undefined
      ) {
        continue
      }
      out.set(id, { cacheRead, input, output })
    } else if (amounts.length === 5) {
      const [cacheWrite, cacheWrite1h, cacheRead, input, output] = amounts
      if (
        cacheWrite === undefined ||
        cacheWrite1h === undefined ||
        cacheRead === undefined ||
        input === undefined ||
        output === undefined
      ) {
        continue
      }
      out.set(id, { cacheWrite, cacheWrite1h, cacheRead, input, output })
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
