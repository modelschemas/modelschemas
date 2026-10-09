/** OpenCode owns models.dev. Only its two providers may read these facts. */
import { cachedDocs } from './model-facts.ts'
import type { ChatRequestMap } from './request-map.ts'
import { fetchText, sha256Text } from './types.ts'
import type {
  FactSource,
  ModelFactSources,
  ModelInfo,
  ModelReasoning,
} from './types.ts'

export const OPENCODE_CATALOG_URL = 'https://models.dev/api.json'
type OpenCodeProvider = 'opencode' | 'opencode-go'

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function strings(value: unknown): value is Array<string> {
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
}
function reasoning(value: unknown): ModelReasoning | null {
  if (value === undefined) return null
  if (!Array.isArray(value))
    throw new Error('opencode: unreadable reasoning_options')
  const options = value.map((option: unknown) => {
    if (
      !record(option) ||
      !['toggle', 'effort', 'budget_tokens'].includes(String(option.type))
    ) {
      throw new Error('opencode: unreadable reasoning option')
    }
    if (
      option.type === 'effort' &&
      (!strings(option.values) || option.values.length === 0)
    ) {
      throw new Error('opencode: unreadable effort values')
    }
    return option
  })
  const toggle = options.some((option) => option.type === 'toggle')
  const effort = options.find((option) => option.type === 'effort')
  if (effort && strings(effort.values))
    return {
      mode: 'effort',
      efforts: effort.values,
      mandatory:
        toggle ||
        effort.values.some((v) => ['none', 'off', 'disabled'].includes(v))
          ? false
          : null,
    }
  if (options.some((option) => option.type === 'budget_tokens'))
    return { mode: 'budget', mandatory: toggle ? false : null }
  return toggle ? { mode: 'toggle', mandatory: false } : null
}

export function parseOpenCodeCatalog(
  payload: unknown,
  provider: OpenCodeProvider,
  hash: string,
): Record<string, ModelInfo> {
  if (
    !record(payload) ||
    !record(payload[provider]) ||
    !record(payload[provider].models)
  ) {
    throw new Error(`${provider}: models.dev has no provider models object`)
  }
  const out: Record<string, ModelInfo> = {}
  for (const [id, row] of Object.entries(payload[provider].models)) {
    if (!record(row) || row.id !== id)
      throw new Error(`${provider}: unreadable catalog model ${id}`)
    const source = (path: string): FactSource => ({
      derivation: 'listing',
      sourceUrl: OPENCODE_CATALOG_URL,
      sourceHash: hash,
      path: `${provider}.models.${id}.${path}`,
    })
    const factSources: ModelFactSources = {}
    const model: ModelInfo = {
      rawId: id,
      contextWindow: null,
      maxOutput: null,
      modalities: null,
      capabilities: null,
      reasoning: reasoning(row.reasoning_options),
      requestMap: null,
      providerMetadata: row,
    }
    if (row.limit !== undefined) {
      if (!record(row.limit))
        throw new Error(`${provider}: unreadable limits for ${id}`)
      for (const [key, fact] of [
        ['context', 'contextWindow'],
        ['output', 'maxOutput'],
      ] as const) {
        const value = row.limit[key]
        if (value === undefined) continue
        if (
          typeof value !== 'number' ||
          !Number.isSafeInteger(value) ||
          value <= 0
        )
          throw new Error(`${provider}: unreadable ${key} limit for ${id}`)
        model[fact] = value
        factSources[fact] = source(`limit.${key}`)
      }
    }
    if (row.modalities !== undefined) {
      if (
        !record(row.modalities) ||
        !strings(row.modalities.input) ||
        !strings(row.modalities.output)
      )
        throw new Error(`${provider}: unreadable modalities for ${id}`)
      model.modalities = row.modalities
      factSources.modalities = source('modalities')
    }
    const capabilities: Record<string, boolean> = {}
    const sources: Record<string, FactSource> = {}
    for (const [field, flag] of [
      ['tool_call', 'tools'],
      ['reasoning', 'reasoning'],
      ['structured_output', 'structured_outputs'],
    ] as const) {
      if (row[field] === undefined) continue
      if (typeof row[field] !== 'boolean')
        throw new Error(`${provider}: unreadable ${field} for ${id}`)
      capabilities[flag] = row[field]
      sources[flag] = source(field)
    }
    if (record(row.modalities) && strings(row.modalities.input)) {
      capabilities.vision = row.modalities.input.includes('image')
      sources.vision = source('modalities.input')
    }
    if (Object.keys(capabilities).length) {
      model.capabilities = capabilities
      factSources.capabilities = sources
    }
    if (model.reasoning) factSources.reasoning = source('reasoning_options')
    if (
      row.interleaved !== undefined &&
      typeof row.interleaved !== 'boolean' &&
      (!record(row.interleaved) || typeof row.interleaved.field !== 'string')
    )
      throw new Error(`${provider}: unreadable interleaved for ${id}`)
    if (
      record(row.interleaved) &&
      row.interleaved.field === 'reasoning_content'
    ) {
      const map: ChatRequestMap = {
        thinking: null,
        maxTokensField: null,
        developerRole: null,
        replayReasoningContent: true,
        store: null,
        strictTools: null,
        sessionAffinity: null,
        cacheControl: null,
        toolStream: null,
        reasoningEffort: null,
      }
      model.requestMap = map
      factSources.requestMap = source('interleaved.field')
    }
    model.factSources = factSources
    out[id] = model
  }
  if (!Object.keys(out).length)
    throw new Error(`${provider}: models.dev listed no models`)
  return out
}

export async function openCodeCatalog(
  provider: OpenCodeProvider,
  kv?: KVNamespace,
): Promise<Record<string, ModelInfo>> {
  const catalog = await cachedDocs(kv, OPENCODE_CATALOG_URL, async () => {
    const text = await fetchText(OPENCODE_CATALOG_URL, {
      signal: AbortSignal.timeout(30_000),
    })
    return {
      payload: JSON.parse(text) as unknown,
      hash: await sha256Text(text),
    }
  })
  return parseOpenCodeCatalog(catalog.payload, provider, catalog.hash)
}
