/**
 * SambaNova catalog facts the models list does not state.
 * Modalities: the SambaCloud models table.
 * Capability flags: ChatCompletionRequest in SambaNova's inference OpenAPI,
 * minus fields the description says are unimplemented or only on some
 * models. `tools` / `tool_choice` only for ids on the function-calling page.
 * `seed` is dropped for a multimodal row. The compatibility page says seed
 * is not supported on multi-modality models:
 * https://docs.sambanova.ai/docs/en/features/openai-compatibility.md
 */
import { markdownSection, markdownTableRows } from './model-facts.ts'
import type { FactSource, ModelInfo } from './types.ts'

export const SAMBANOVA_MODELS_DOCS_URL =
  'https://docs.sambanova.ai/docs/en/models/sambacloud-models.md'
export const SAMBANOVA_SPEC_URL =
  'https://raw.githubusercontent.com/sambanova/sambanova-inference-api-spec/refs/heads/main/openapi.documented.json'
export const SAMBANOVA_TOOLS_DOCS_URL =
  'https://docs.sambanova.ai/docs/en/features/function-calling.md'

const MODALITY: Record<string, string> = {
  text: 'text',
  image: 'image',
  video: 'video',
  audio: 'audio',
}

/** Property name on ChatCompletionRequest → stored capability flag. */
const PROPERTY_FLAGS: Record<string, string> = {
  tools: 'tools',
  tool_choice: 'tool_choice',
  max_tokens: 'max_tokens',
  max_completion_tokens: 'max_tokens',
  temperature: 'temperature',
  top_p: 'top_p',
  top_k: 'top_k',
  stop: 'stop',
  seed: 'seed',
  response_format: 'response_format',
  reasoning_effort: 'reasoning_effort',
}

const FLAG_ORDER = [
  'tools',
  'tool_choice',
  'max_tokens',
  'temperature',
  'top_p',
  'top_k',
  'stop',
  'seed',
  'response_format',
  'structured_outputs',
  'reasoning_effort',
]

export interface SambanovaModalities {
  input: Array<string>
  output: Array<string>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cellText(cell: string): string {
  return cell.replace(/[`*]/g, '').trim()
}

/**
 * Both production and preview tables. Context length is not copied: the
 * listing's `context_length` is the stored window (gemma's cell says 128k;
 * the models API reports the 256k text window).
 */
export function parseSambanovaModelModalities(
  markdown: string,
): Map<string, SambanovaModalities> {
  const rows = markdownTableRows(markdown)
  const header = rows.find(
    (cells) =>
      cells.some((cell) => /model id/i.test(cellText(cell))) &&
      cells.some((cell) => /modalit/i.test(cellText(cell))),
  )
  if (!header) {
    throw new Error('sambanova models page: no modalities table')
  }
  const idCol = header.findIndex((cell) => /model id/i.test(cellText(cell)))
  const modCol = header.findIndex((cell) => /modalit/i.test(cellText(cell)))
  const out = new Map<string, SambanovaModalities>()
  for (const cells of rows) {
    if (cells === header) continue
    const id = cellText(cells[idCol] ?? '')
    if (!id || /model id/i.test(id)) continue
    const parts = cellText(cells[modCol] ?? '')
      .split(/[,/]/)
      .map((part) => part.trim().toLowerCase())
      .filter((part) => part.length > 0)
    if (parts.length === 0) {
      throw new Error(
        `sambanova models page: ${id} has an empty modalities cell`,
      )
    }
    const input = parts.map((part) => {
      const modality = MODALITY[part]
      if (!modality) {
        throw new Error(
          `sambanova models page: ${id} has unknown modality "${part}"`,
        )
      }
      return modality
    })
    // Chat rows that omit text were a bad store (input image/audio only).
    if (!input.includes('text')) {
      throw new Error(`sambanova models page: ${id} modalities omit text`)
    }
    // The column is inputs (the gemma note). Chat completions return text.
    out.set(id, { input, output: ['text'] })
  }
  return out
}

/** Ids under `## Supported models` on the function-calling page. */
export function parseSambanovaToolModels(markdown: string): Set<string> {
  const section = markdownSection(`\n${markdown}`, 'Supported models')
  if (!section) {
    throw new Error('sambanova function calling: no Supported models section')
  }
  const ids = [...section.matchAll(/^\* `([^`]+)`/gm)]
    .map((match) => match[1])
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
  if (ids.length === 0) {
    throw new Error('sambanova function calling: no model ids')
  }
  return new Set(ids)
}

function descriptionOf(property: Record<string, unknown>): string {
  return typeof property.description === 'string' ? property.description : ''
}

/** Implemented request fields. Unimplemented and "some models" stay out. */
export function parseSambanovaChatFlags(spec: unknown): Array<string> {
  if (!isRecord(spec) || !isRecord(spec.components)) {
    throw new Error('sambanova chat spec: no components')
  }
  const schemas = spec.components.schemas
  if (!isRecord(schemas) || !isRecord(schemas.ChatCompletionRequest)) {
    throw new Error('sambanova chat spec: no ChatCompletionRequest')
  }
  const properties = schemas.ChatCompletionRequest.properties
  if (!isRecord(properties)) {
    throw new Error(
      'sambanova chat spec: ChatCompletionRequest has no properties',
    )
  }
  const flags = new Set<string>()
  let responseFormat = ''
  for (const [name, property] of Object.entries(properties)) {
    if (!isRecord(property)) continue
    const description = descriptionOf(property)
    if (
      /not currently implemented|only supported for some models/i.test(
        description,
      )
    ) {
      continue
    }
    const flag = PROPERTY_FLAGS[name]
    if (flag) flags.add(flag)
    if (name === 'response_format') responseFormat = description
  }
  if (/json_schema/i.test(responseFormat)) flags.add('structured_outputs')
  if (flags.size === 0) {
    throw new Error('sambanova chat spec: parsed 0 capability flags')
  }
  return FLAG_ORDER.filter((flag) => flags.has(flag))
}

export interface SambanovaDocsLoad {
  modalities: {
    byId: Record<string, SambanovaModalities>
    hash: string
  } | null
  flags: { flags: Array<string>; hash: string } | null
  tools: { ids: Array<string>; hash: string } | null
}

function docsSource(
  url: string,
  hash: string,
  path: string,
  derivation: FactSource['derivation'],
): FactSource {
  return { derivation, sourceUrl: url, sourceHash: hash, path }
}

/**
 * One row's docs patch. A source that failed to load is `unavailable`
 * (keep the stored fact). A model the models table does not name keeps
 * null modalities. `seed` is omitted unless the table says the row is
 * text-only.
 */
export function sambanovaDocsPatch(
  rawId: string,
  loaded: SambanovaDocsLoad,
): Partial<ModelInfo> {
  const absent: NonNullable<ModelInfo['absent']> = {}
  const patch: Partial<ModelInfo> = {}
  const factSources: NonNullable<ModelInfo['factSources']> = {}

  if (!loaded.modalities) {
    absent.modalities = 'unavailable'
  } else {
    const modalities = loaded.modalities.byId[rawId]
    if (modalities) {
      patch.modalities = modalities
      factSources.modalities = docsSource(
        SAMBANOVA_MODELS_DOCS_URL,
        loaded.modalities.hash,
        'Supported modalities',
        'docs-derived',
      )
    }
  }

  if (!loaded.flags || !loaded.tools) {
    absent.capabilities = 'unavailable'
  } else {
    const toolIds = new Set(loaded.tools.ids)
    const modalities = loaded.modalities?.byId[rawId]
    const textOnly =
      modalities !== undefined &&
      modalities.input.every((modality) => modality === 'text')
    const capabilities = loaded.flags.flags.filter((flag) => {
      if ((flag === 'tools' || flag === 'tool_choice') && !toolIds.has(rawId)) {
        return false
      }
      if (flag === 'seed' && !textOnly) return false
      return true
    })
    const capSources: Record<string, FactSource> = {}
    for (const flag of capabilities) {
      if (flag === 'tools' || flag === 'tool_choice') {
        capSources[flag] = docsSource(
          SAMBANOVA_TOOLS_DOCS_URL,
          loaded.tools.hash,
          'Supported models',
          'docs-derived',
        )
      } else {
        capSources[flag] = docsSource(
          SAMBANOVA_SPEC_URL,
          loaded.flags.hash,
          flag === 'structured_outputs'
            ? 'ChatCompletionRequest.properties.response_format'
            : `ChatCompletionRequest.properties.${flag}`,
          'upstream-spec',
        )
      }
    }
    patch.capabilities = capabilities
    patch.exactCapabilities = true
    factSources.capabilities = capSources
  }

  if (Object.keys(factSources).length > 0) patch.factSources = factSources
  if (Object.keys(absent).length > 0) patch.absent = absent
  return patch
}
