/**
 * Shared helpers for catalog facts the native `/models` endpoints omit
 * (issue #53): context window, max output, modalities, per-token pricing,
 * request-feature capabilities.
 *
 * Every provider fills these from its own sources — a first-party extras
 * endpoint where one exists, else the provider's published docs (all four
 * serve model/pricing pages as markdown or stably-classed HTML). No
 * third-party catalog: this service is meant to be the source, not a
 * mirror of one. Rows nothing covers stay null.
 *
 * Docs fetches fail closed: a parse that yields zero rows throws, which
 * fails that provider's poll for the tick instead of writing nulls over
 * populated rows (that would fan out a bogus `model.updated` per model,
 * then another on recovery). Parsed docs are memoised in-isolate for six
 * hours; pricing pages change on release cadence, not poll cadence.
 *
 * Output shapes follow OpenRouter's catalog rows so consumers read one
 * vocabulary: pricing is USD-per-token strings (`prompt`, `completion`,
 * `input_cache_read`, `input_cache_write`), modalities use `file` for
 * documents, and capabilities are OpenRouter `supported_parameters` names
 * used as feature flags — the native wire names differ (Gemini `toolConfig`,
 * Anthropic `output_config.format`).
 */
import type { ModelInfo } from './types.ts'

export type ModelFacts = Pick<
  ModelInfo,
  'contextWindow' | 'maxOutput' | 'modalities' | 'pricing' | 'capabilities'
>

export const NO_FACTS: ModelFacts = {
  contextWindow: null,
  maxOutput: null,
  modalities: null,
  pricing: null,
  capabilities: null,
}

/** USD/1M → USD/token as a plain decimal string (no exponent notation). */
export function perTokenPrice(usdPerMillion: number): string {
  return (usdPerMillion / 1e6).toFixed(12).replace(/\.?0+$/, '')
}

/**
 * OpenRouter-shaped pricing from USD-per-million figures; keys with no
 * figure are omitted, an empty result is null.
 */
export function pricingPerMillion(usd: {
  prompt?: number | null
  completion?: number | null
  input_cache_read?: number | null
  input_cache_write?: number | null
}): Record<string, string> | null {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(usd)) {
    if (typeof value === 'number') out[key] = perTokenPrice(value)
  }
  return Object.keys(out).length > 0 ? out : null
}

/**
 * Snapshot ids fall back to their alias:
 * `gpt-5-2025-08-07` → `gpt-5`, `claude-opus-4-5-20251101` → `claude-opus-4-5`.
 */
export function undatedId(rawId: string): string {
  return rawId.replace(/-\d{4}-\d{2}-\d{2}$|-\d{8}$/, '')
}

/**
 * First per-token `$` amount in a docs cell (`$0.30 (text / image)` →
 * 0.3). Per-unit figures sharing the cell (`$0.039 per image`,
 * `$0.35 / sec`, `$1.00 / 1,000,000 tokens per hour`) are skipped.
 */
export function dollars(cell: string | undefined): number | null {
  if (!cell) return null
  for (const m of cell.matchAll(/\$\s*([\d,]*\.?\d+)([^$]*)/g)) {
    if (
      /^\s*(per|\/)\s*(image|sec|min|hour|hr|\d|1K|2K|4K)/i.test(m[2] ?? '')
    ) {
      continue
    }
    if (m[1]) return Number(m[1].replace(/,/g, ''))
  }
  return null
}

/** `1,048,576` / `500k` / `1M` → number. */
export function tokenCount(text: string | undefined): number | null {
  const match = text?.match(/([\d,]*\.?\d+)\s*([kKmM])?/)
  if (!match?.[1]) return null
  const base = Number(match[1].replace(/,/g, ''))
  const unit = match[2]?.toLowerCase()
  return Math.round(base * (unit === 'm' ? 1e6 : unit === 'k' ? 1e3 : 1))
}

/**
 * Every `| a | b |` row in a markdown document as trimmed cells, separator
 * rows dropped. Callers pick rows by content; header rows come along.
 */
export function markdownTableRows(text: string): Array<Array<string>> {
  const rows: Array<Array<string>> = []
  for (const line of text.split('\n')) {
    if (!line.startsWith('|')) continue
    const cells = line
      .slice(1, line.endsWith('|') ? -1 : undefined)
      .split('|')
      .map((cell) => cell.trim())
    if (cells.every((cell) => /^:?-+:?$/.test(cell))) continue
    rows.push(cells)
  }
  return rows
}

const memo = new Map<string, { at: number; value: Promise<unknown> }>()
const MEMO_TTL_MS = 6 * 60 * 60_000

/**
 * In-isolate memo for parsed docs. A rejected fetch is evicted so the next
 * poll retries. Keyed by URL; the value is whatever the parser returns.
 */
export function memoized<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = memo.get(key)
  if (hit && Date.now() - hit.at < MEMO_TTL_MS) return hit.value as Promise<T>
  const value = load()
  memo.set(key, { at: Date.now(), value })
  value.catch(() => {
    if (memo.get(key)?.value === value) memo.delete(key)
  })
  return value
}

/** Throw when a docs parse comes back empty — never silently null a catalog. */
export function assertParsed<T>(rows: Map<string, T>, source: string): void {
  if (rows.size === 0) throw new Error(`${source}: parsed 0 model rows`)
}

/** Bounded-concurrency map, order preserved. */
export async function mapConcurrent<T, TResult>(
  items: Array<T>,
  limit: number,
  fn: (item: T) => Promise<TResult>,
): Promise<Array<TResult>> {
  const results: Array<TResult> = new Array<TResult>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index] as T)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  )
  return results
}
