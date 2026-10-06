/**
 * Cohere's models overview. `GET /v1/models` gives the context length and
 * features but no output cap, and the chat spec's `max_tokens` points here
 * for "the maximum output token limits for each model". The Command, North
 * and Aya tables share the columns read below. Cells are matched whole: a
 * row with a reworded status, modality or limit is dropped, never guessed.
 */
import { tagDocsFacts } from './fact-sources.ts'
import { assertParsed, cachedDocs, markdownTableRows } from './model-facts.ts'
import { fetchText, sha256Text } from './types.ts'
import type { ModelInfo } from './types.ts'

export const COHERE_MODELS_DOC_URL = 'https://docs.cohere.com/docs/models.md'

const COLUMNS = [
  'Model Name',
  'Status',
  'Modality',
  'Maximum Output Tokens',
  'Endpoints',
] as const

const INPUT: Record<string, string> = { Text: 'text', Images: 'image' }

export interface CohereDocRow {
  /** Status is exactly `Live`, not `Deprecated …` or `Retired …`. */
  live: boolean
  input: Array<string>
  maxOutput: number
}

/** API id → the chat facts its table row states. */
export function parseCohereModelTable(
  markdown: string,
): Map<string, CohereDocRow> {
  const out = new Map<string, CohereDocRow>()
  let header: Array<string> | null = null
  for (const cells of markdownTableRows(markdown)) {
    if (cells[0] === 'Model Name') {
      header = COLUMNS.every((name) => cells.includes(name)) ? cells : null
      continue
    }
    if (!header || cells.length !== header.length) continue
    const cell = (name: (typeof COLUMNS)[number]) =>
      cells[header?.indexOf(name) ?? -1] ?? ''
    const id = /^`([a-z0-9][a-z0-9.-]*)`$/.exec(cell('Model Name'))?.[1]
    const thousands = /^(\d+)k$/i.exec(cell('Maximum Output Tokens'))?.[1]
    const input = cell('Modality')
      .split(',')
      .map((word) => INPUT[word.trim()])
    // The chat endpoint is what makes the output text.
    if (!id || !thousands || !/\[Chat\]\(/.test(cell('Endpoints'))) continue
    if (!input.every((modality) => modality !== undefined)) continue
    out.set(id, {
      live: cell('Status') === 'Live',
      input,
      maxOutput: Number(thousands) * 1000,
    })
  }
  return out
}

/** The parsed overview page with its hash, cached like every docs page. */
export function cohereModelDocs(kv?: KVNamespace) {
  return cachedDocs(kv, COHERE_MODELS_DOC_URL, async () => {
    const markdown = await fetchText(COHERE_MODELS_DOC_URL, {
      signal: AbortSignal.timeout(30_000),
    })
    const parsed = parseCohereModelTable(markdown)
    assertParsed(parsed, 'cohere models page')
    return {
      rows: Object.fromEntries(parsed),
      hash: await sha256Text(markdown),
    }
  })
}

type DocFacts = Pick<ModelInfo, 'maxOutput' | 'modalities' | 'factSources'>

/** Facts by listed model id. An id the page has no row for gets nothing. */
export async function cohereModelDocFacts(
  kv?: KVNamespace,
): Promise<(rawId: string) => DocFacts> {
  const doc = await cohereModelDocs(kv)
  return (rawId) => {
    const row = doc.rows[rawId]
    if (!row) return {}
    const facts = {
      maxOutput: row.maxOutput,
      modalities: { input: row.input, output: ['text'] },
    }
    return {
      ...facts,
      factSources: tagDocsFacts(facts, COHERE_MODELS_DOC_URL, doc.hash),
    }
  }
}
