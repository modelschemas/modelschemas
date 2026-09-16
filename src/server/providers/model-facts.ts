/**
 * Shared helpers for catalog facts the native `/models` endpoints omit
 * (issue #53): context window, max output, modalities, request-feature
 * capabilities. Docs parses fail closed (zero rows throws). Parsed docs
 * live in KV for six hours so cron isolates do not refetch every tick.
 */
import { getJson, putJson } from '#/server/kv.ts'

import type { ModelInfo } from './types.ts'

export type ModelFacts = Pick<
  ModelInfo,
  | 'contextWindow'
  | 'maxOutput'
  | 'modalities'
  | 'capabilities'
  | 'pricing'
  | 'factSources'
>

export const NO_FACTS: ModelFacts = {
  contextWindow: null,
  maxOutput: null,
  modalities: null,
  capabilities: null,
  pricing: null,
}

/**
 * Snapshot ids fall back to their alias:
 * `gpt-5-2025-08-07` → `gpt-5`, `claude-opus-4-5-20251101` → `claude-opus-4-5`.
 */
export function undatedId(rawId: string): string {
  return rawId.replace(/-\d{4}-\d{2}-\d{2}$|-\d{8}$/, '')
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

const DOCS_TTL_SECONDS = 6 * 60 * 60

/**
 * KV cache for parsed docs, keyed by source URL. A failed load is not
 * stored, so the next poll retries. `kv` is omitted in unit tests that
 * never hit the network.
 */
export async function cachedDocs<T>(
  kv: KVNamespace | undefined,
  url: string,
  load: () => Promise<T>,
): Promise<T> {
  const key = `docs:${url}`
  if (kv) {
    const hit = await getJson<T>(kv, key)
    if (hit !== null) return hit
  }
  const value = await load()
  if (kv) {
    await putJson(kv, key, value, { expirationTtl: DOCS_TTL_SECONDS })
  }
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
      const item = items[index]
      if (item === undefined) continue
      results[index] = await fn(item)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  )
  return results
}
