/**
 * Azure OpenAI catalog facts from two Microsoft Learn articles, read as
 * their markdown twins (`Accept: text/markdown`).
 *
 * The models article has one `Model ID` table per family under a `## `
 * heading; the heading and the table's columns give the activity, and the
 * row gives the token limits and a capability list. The reasoning article
 * has a feature matrix with one column per model; where a model has a
 * column there, its ✅ / - cells win over the capability list.
 *
 * Effort levels are stated only in that article's footnotes and prose, so
 * `reasoning` stays null here.
 */
import type { Activity } from '#/db/schema.ts'

import { markdownTableRows, tokenCount } from './model-facts.ts'
import type { FactSource, ModelFactSources, ModelInfo } from './types.ts'

export const AZURE_MODELS_URL =
  'https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-sold-directly-by-azure'
export const AZURE_REASONING_URL =
  'https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/reasoning'

/** `## ` headings whose `Model ID` tables are not chat models. */
const SECTION_ACTIVITY: Array<[RegExp, Activity]> = [
  [/^Embeddings/i, 'embeddings'],
  [/^Image generation/i, 'image'],
  [/^Video generation/i, 'video'],
  [/^Audio/i, 'audio'],
]

/** Tables that repeat ids from the family sections with no model facts. */
const SKIPPED_SECTION = /^(Fine-tuning|Assistants|Model retirement)/i

export interface AzureModelRow {
  rawId: string
  /** `YYYY-MM-DD` of the row's model version, when the row dates it. */
  version: string | null
  retired: boolean
  activity: Activity | null
  contextWindow: number | null
  maxOutput: number | null
  modalities: { input: Array<string>; output: Array<string> } | null
  capabilities: Array<string>
  chatCompletions: boolean
  responses: boolean
}

/** One model's column in the reasoning article's feature matrix. */
export interface AzureFeatureColumn {
  capabilities: Array<string>
  modalities: { input: Array<string>; output: Array<string> } | null
  chatCompletions: boolean | null
  responses: boolean | null
}

/** Link targets hold words like `reasoning` that are not statements. */
function plain(cell: string): string {
  return cell.replace(/\]\([^)]*\)/g, ']')
}

function descriptionModalities(text: string): AzureModelRow['modalities'] {
  const output = /text output|text only|text out\b|input\/output/i.test(text)
    ? ['text']
    : []
  if (
    /text and image (?:processing|input)|input\*\*: text\/image|image \(input\)/i.test(
      text,
    )
  ) {
    return { input: ['text', 'image'], output }
  }
  if (/text in\/text out only|text-only processing/i.test(text)) {
    return { input: ['text'], output }
  }
  return null
}

function descriptionCapabilities(text: string): Array<string> {
  const caps: Array<string> = []
  if (/\bfunctions?\b|\btools\b/i.test(text)) caps.push('tools')
  if (/\breasoning\b/i.test(text)) caps.push('reasoning')
  if (/structured outputs/i.test(text)) {
    caps.push('structured_outputs', 'response_format')
  }
  return caps
}

/** Newest non-retired row wins; a model with only retired rows keeps one. */
function better(next: AzureModelRow, current: AzureModelRow): boolean {
  if (next.retired !== current.retired) return !next.retired
  return (next.version ?? '') > (current.version ?? '')
}

/** Every model the Azure OpenAI pivot tabulates, by id. */
export function parseAzureModels(markdown: string): Map<string, AzureModelRow> {
  // Learn serves the twin with CRLF line ends in places.
  const text = markdown.replace(/\r/g, '')
  const start = text.indexOf('::: zone pivot="azure-openai"')
  const end = text.indexOf('::: zone-end', start)
  const zone = start < 0 ? '' : text.slice(start, end < 0 ? undefined : end)

  const out = new Map<string, AzureModelRow>()
  for (const section of zone.split(/\n## /).slice(1)) {
    const heading = section.slice(0, section.indexOf('\n')).trim()
    if (SKIPPED_SECTION.test(heading)) continue
    const sectionActivity = SECTION_ACTIVITY.find(([pattern]) =>
      pattern.test(heading),
    )?.[1]

    let columns: Array<string> | null = null
    for (const cells of markdownTableRows(section)) {
      if (cells[0] === 'Model ID') {
        columns = cells.map((cell) => cell.toLowerCase())
        continue
      }
      if (!columns) continue
      const cell = (name: string): string | undefined => {
        const index = columns?.indexOf(name) ?? -1
        return index < 0 ? undefined : cells[index]
      }
      const window = cell('context window')
      const request = cell('max request (tokens)')
      // Without a token-limit column the family is not a chat family.
      const activity =
        sectionActivity ?? (window != null || request != null ? 'chat' : null)
      const input = request?.match(/Input:\s*([\d,]+)/)?.[1]
      const description = plain(cell('description') ?? '')

      const idCell = cells[0] ?? ''
      const retired = /\*\*Retired/.test(idCell)
      for (const match of idCell.matchAll(
        /`([^`]+)`(?:\^\d+\^)?\s*(?:\(([^)]*)\))?/g,
      )) {
        const rawId = match[1]?.trim()
        if (!rawId) continue
        const row: AzureModelRow = {
          rawId,
          version: match[2]?.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null,
          retired,
          activity,
          contextWindow: tokenCount(
            window ?? input ?? (/^[\d,]+$/.test(request ?? '') ? request : ''),
          ),
          maxOutput: tokenCount(
            cell('max output tokens') ??
              request?.match(/Output:\s*([\d,]+)/)?.[1],
          ),
          modalities: descriptionModalities(description),
          capabilities: descriptionCapabilities(description),
          chatCompletions: /chat completions api/i.test(description),
          responses: /responses api/i.test(description),
        }
        const current = out.get(rawId)
        if (!current || better(row, current)) out.set(rawId, row)
      }
    }
  }
  return out
}

const MATRIX_CAPABILITIES: Array<[RegExp, Array<string>]> = [
  [/^functions\/tools/i, ['tools']],
  [/^reasoning effort/i, ['reasoning']],
  [/^structured outputs/i, ['structured_outputs', 'response_format']],
]

function modalityWords(cell: string): Array<string> {
  return ['text', 'image'].filter((word) => cell.toLowerCase().includes(word))
}

/** The `Feature` matrices of the reasoning article, by model id. */
export function parseAzureFeatureMatrix(
  markdown: string,
): Map<string, AzureFeatureColumn> {
  const out = new Map<string, AzureFeatureColumn>()
  let ids: Array<string | null> = []
  for (const cells of markdownTableRows(markdown.replace(/\r/g, ''))) {
    const label = plain(cells[0] ?? '')
      .replace(/[*[\]`]|\^[^^]*\^/g, '')
      .trim()
    if (label === 'Feature') {
      // `**gpt-5.4**,**2026-03-05**` → `gpt-5.4`. The plain
      // `Feature | Description` table has no model columns.
      ids = cells.map((cell, index) =>
        index === 0 || !cell.startsWith('**')
          ? null
          : (cell.replace(/\*/g, '').split(',')[0]?.trim() ?? null),
      )
      for (const id of ids) {
        if (!id || out.has(id)) continue
        out.set(id, {
          capabilities: [],
          modalities: null,
          chatCompletions: null,
          responses: null,
        })
      }
      continue
    }
    for (const [index, id] of ids.entries()) {
      const column = id ? out.get(id) : undefined
      const cell = cells[index]
      if (!column || cell == null) continue
      const yes = cell.startsWith('✅')
      const caps = MATRIX_CAPABILITIES.find(([pattern]) => pattern.test(label))
      if (caps && yes) column.capabilities.push(...caps[1])
      else if (/^image input/i.test(label)) {
        column.modalities = {
          input: yes ? ['text', 'image'] : ['text'],
          output: column.modalities?.output ?? [],
        }
      } else if (/^input modalities/i.test(label)) {
        column.modalities = {
          input: modalityWords(cell),
          output: column.modalities?.output ?? [],
        }
      } else if (/^output modalities/i.test(label)) {
        column.modalities = {
          input: column.modalities?.input ?? [],
          output: modalityWords(cell),
        }
      } else if (/^chat completions api/i.test(label)) {
        column.chatCompletions = yes
      } else if (/^responses api/i.test(label)) {
        column.responses = yes
      }
    }
  }
  return out
}

function docsSource(sourceUrl: string, sourceHash: string) {
  return (path: string): FactSource => ({
    derivation: 'docs-derived',
    sourceUrl,
    sourceHash,
    path,
  })
}

/**
 * One catalog row. The matrix column, where the model has one, overrides
 * the models article for capabilities, modalities, and the API it serves.
 */
export function azureModelInfo(
  row: AzureModelRow,
  column: AzureFeatureColumn | undefined,
  hashes: { models: string; reasoning: string },
): ModelInfo {
  const models = docsSource(AZURE_MODELS_URL, hashes.models)
  const matrix = docsSource(AZURE_REASONING_URL, hashes.reasoning)
  const chat = row.activity === 'chat'

  const capabilities = chat
    ? [...new Set([...(column?.capabilities ?? []), ...row.capabilities])]
    : []
  const modalities =
    column?.modalities && column.modalities.input.length > 0
      ? column.modalities
      : row.modalities
  const chatCompletions = column?.chatCompletions ?? row.chatCompletions
  const responses = column?.responses ?? row.responses

  const factSources: ModelFactSources = {}
  if (row.contextWindow != null) {
    factSources.contextWindow = models('contextWindow')
  }
  if (row.maxOutput != null) factSources.maxOutput = models('maxOutput')
  if (modalities) {
    factSources.modalities = (modalities === row.modalities ? models : matrix)(
      'modalities',
    )
  }
  if (capabilities.length > 0) {
    factSources.capabilities = Object.fromEntries(
      capabilities.map((flag) => [
        flag,
        (column?.capabilities.includes(flag) ? matrix : models)(
          `capabilities.${flag}`,
        ),
      ]),
    )
  }

  return {
    rawId: row.rawId,
    activity: row.activity,
    contextWindow: row.contextWindow,
    maxOutput: row.maxOutput,
    modalities,
    capabilities: capabilities.length > 0 ? capabilities : null,
    // A chat model that serves only the Responses API binds to that route.
    schemaEndpointId: !chat
      ? null
      : chatCompletions
        ? 'chat/completions'
        : responses
          ? 'responses'
          : null,
    deprecated: row.retired,
    pricing: null,
    factSources,
  }
}
