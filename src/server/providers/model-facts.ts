/**
 * Catalog facts the native `/models` endpoints omit (issue #53): context
 * window, max output, modalities, per-token pricing, and the request
 * features a model accepts. Source: models.dev (github.com/sst/models.dev),
 * a maintained machine-readable catalog. Fetched at most once per poll —
 * one payload covers OpenAI, Anthropic, Google, and xAI — and memoised for
 * ten minutes so the four providers share it. A failed fetch throws, which
 * fails that provider's poll for the tick instead of writing nulls over
 * previously populated rows (that would fan out a bogus `model.updated`
 * per model, then another when the source recovers).
 *
 * First-party facts win where the provider publishes them (Anthropic
 * `max_input_tokens` / `max_tokens`, Gemini token limits) — callers spread
 * these facts first and override.
 *
 * Output shapes follow OpenRouter's catalog rows so consumers read one
 * vocabulary: pricing is USD-per-token strings (`prompt`, `completion`,
 * `input_cache_read`, `input_cache_write`), modalities use `file` for
 * documents, and capabilities are OpenRouter `supported_parameters` names
 * used as feature flags — the native wire names differ (Gemini `toolConfig`,
 * Anthropic `output_config.format`).
 */
import { fetchJson } from './types.ts'
import type { ModelInfo } from './types.ts'

export const MODELS_DEV_URL = 'https://models.dev/api.json'

export interface ModelsDevModel {
  reasoning?: boolean
  reasoning_options?: Array<{ type: string }>
  tool_call?: boolean
  structured_output?: boolean
  temperature?: boolean
  modalities?: { input?: Array<string>; output?: Array<string> }
  limit?: { context?: number; output?: number }
  /** USD per million tokens. */
  cost?: Record<string, number | undefined>
}

type ModelsDevCatalog = Record<
  string,
  { models?: Record<string, ModelsDevModel> } | undefined
>

export type ModelFacts = Pick<
  ModelInfo,
  'contextWindow' | 'maxOutput' | 'modalities' | 'pricing' | 'capabilities'
>

const EMPTY: ModelFacts = {
  contextWindow: null,
  maxOutput: null,
  modalities: null,
  pricing: null,
  capabilities: null,
}

const PRICE_KEYS: Record<string, string> = {
  prompt: 'input',
  completion: 'output',
  input_cache_read: 'cache_read',
  input_cache_write: 'cache_write',
}

/** USD/1M → USD/token as a plain decimal string (no exponent notation). */
export function perTokenPrice(usdPerMillion: number): string {
  return (usdPerMillion / 1e6).toFixed(12).replace(/\.?0+$/, '')
}

/**
 * Snapshot ids fall back to the alias models.dev keys on:
 * `gpt-5-2025-08-07` → `gpt-5`, `claude-opus-4-5-20251101` → `claude-opus-4-5`.
 */
export function undatedId(rawId: string): string {
  return rawId.replace(/-\d{4}-\d{2}-\d{2}$|-\d{8}$/, '')
}

export function factsFromModelsDev(
  entry: ModelsDevModel | undefined,
): ModelFacts {
  if (!entry) return EMPTY
  const capabilities: Array<string> = []
  if (entry.tool_call) capabilities.push('tools', 'tool_choice')
  if (entry.reasoning) capabilities.push('reasoning')
  if (entry.reasoning_options?.some((o) => o.type === 'effort')) {
    capabilities.push('reasoning_effort')
  }
  if (entry.temperature) capabilities.push('temperature', 'top_p')
  if (entry.structured_output) {
    capabilities.push('structured_outputs', 'response_format')
  }
  const pricing: Record<string, string> = {}
  for (const [ours, theirs] of Object.entries(PRICE_KEYS)) {
    const value = entry.cost?.[theirs]
    if (typeof value === 'number') pricing[ours] = perTokenPrice(value)
  }
  const toModality = (m: string) => (m === 'pdf' ? 'file' : m)
  return {
    contextWindow: entry.limit?.context ?? null,
    maxOutput: entry.limit?.output ?? null,
    modalities: entry.modalities
      ? {
          input: (entry.modalities.input ?? []).map(toModality),
          output: (entry.modalities.output ?? []).map(toModality),
        }
      : null,
    pricing: Object.keys(pricing).length > 0 ? pricing : null,
    capabilities: capabilities.length > 0 ? capabilities : null,
  }
}

const TTL_MS = 10 * 60_000
let cached: { at: number; catalog: Promise<ModelsDevCatalog> } | undefined

/**
 * Lookup for one models.dev provider key (`openai`, `anthropic`, `google`,
 * `xai`). Unknown ids resolve to all-null facts.
 */
export async function modelFactsLookup(
  modelsDevProvider: string,
): Promise<(rawId: string) => ModelFacts> {
  if (!cached || Date.now() - cached.at > TTL_MS) {
    const catalog = fetchJson(MODELS_DEV_URL) as Promise<ModelsDevCatalog>
    cached = { at: Date.now(), catalog }
    catalog.catch(() => {
      if (cached?.catalog === catalog) cached = undefined
    })
  }
  const models = (await cached.catalog)[modelsDevProvider]?.models ?? {}
  return (rawId) =>
    factsFromModelsDev(models[rawId] ?? models[undatedId(rawId)])
}
