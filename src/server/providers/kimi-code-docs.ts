/** Kimi Code's own transposed model table, not an API compatibility catalog. */
import type { FactSource, ModelInfo, ModelReasoning } from './types.ts'

export const KIMI_CODE_MODELS_URL =
  'https://www.kimi.com/code/docs/en/kimi-code/models.html'

function fail(message: string): never {
  throw new Error(`kimi-code: ${message}`)
}
function text(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}
function codes(html: string): Array<string> {
  return [...html.matchAll(/<code\b[^>]*>([\s\S]*?)<\/code>/g)].map((match) =>
    text(match[1] ?? ''),
  )
}

interface ModelColumn {
  rawId: string
  cells: Map<string, string>
}

function modelColumns(html: string): Array<ModelColumn> {
  const matches: Array<Array<Array<string>>> = []
  for (const table of html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/g)) {
    const rows = [
      ...(table[1] ?? '').matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g),
    ].map((row) =>
      [...(row[1] ?? '').matchAll(/<t[dh]\b([^>]*)>([\s\S]*?)<\/t[dh]>/g)].map(
        (cell) => {
          if (/\b(?:rowspan|colspan)=/.test(cell[1] ?? ''))
            fail('unexpected spans in model table')
          return cell[2] ?? ''
        },
      ),
    )
    if (text(rows[0]?.[0] ?? '') === 'Model ID') matches.push(rows)
  }
  if (matches.length !== 1)
    fail('model source must contain exactly one Model ID table')
  const rows = matches[0] ?? fail('missing model table')
  const header = rows[0] ?? fail('missing model header')
  if (header.length < 2) fail('model header names no IDs')
  const columns = header.slice(1).map((cell) => {
    const nativeIds = codes(cell)
    const rawId = nativeIds[0]
    if (
      nativeIds.length !== 1 ||
      !rawId ||
      !/^[a-z0-9][a-z0-9.-]*$/.test(rawId)
    )
      fail('invalid native model ID')
    return { rawId, cells: new Map<string, string>() }
  })
  if (new Set(columns.map((column) => column.rawId)).size !== columns.length)
    fail('duplicate native model ID')
  for (const row of rows.slice(1)) {
    if (row.length !== header.length)
      fail('model source has unequal table widths')
    const label = text(row[0] ?? '')
    if (!label) fail('unlabeled model fact row')
    columns.forEach((column, index) => {
      if (column.cells.has(label)) fail(`duplicate model fact ${label}`)
      column.cells.set(label, row[index + 1] ?? '')
    })
  }
  return columns
}

function contextWindow(raw: string | undefined): number | null {
  if (raw === undefined || /^[-—]$/.test(text(raw))) return null
  const values = codes(raw)
  if (values.length !== 1 || !/^\d+$/.test(values[0] ?? ''))
    fail('unreadable native context window')
  const amount = Number(values[0])
  if (!Number.isSafeInteger(amount) || amount <= 0)
    fail('invalid native context window')
  return amount
}

function reasoning(raw: string | undefined): ModelReasoning | null {
  if (raw === undefined || /^[-—]$/.test(text(raw))) return null
  const values = codes(raw.split(/\(default\b/)[0] ?? raw)
  const first = values[0]
  if (first === 'Thinking:ON') return null // An enabled flag does not name a control or state mandatory.
  if (!first?.startsWith('reasoning_effort:'))
    fail('unrecognized native reasoning control')
  const efforts = [first.slice('reasoning_effort:'.length), ...values.slice(1)]
  if (
    !efforts.length ||
    efforts.some((effort) => !/^[a-z][a-z0-9_-]*$/.test(effort)) ||
    new Set(efforts).size !== efforts.length
  )
    fail('invalid native effort list')
  return { mode: 'effort', mandatory: null, efforts }
}

function media(raw: string | undefined): Array<string> | null {
  if (raw === undefined || /^[-—]$/.test(text(raw))) return null
  const input = text(raw)
    .replace(/\bonly\b/g, '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
  if (
    !input.length ||
    input.some((value) => !['text', 'image', 'video', 'audio'].includes(value))
  )
    fail('unreadable native input modalities')
  return input
}

export function parseKimiCodeModels(
  html: string,
  source: FactSource,
): Array<ModelInfo> {
  return modelColumns(html).map(({ rawId, cells }) => {
    const window = contextWindow(cells.get('Context window'))
    const control = reasoning(cells.get('Reasoning'))
    const input = media(cells.get('Multimodal input'))
    const thinks =
      control !== null ||
      codes(cells.get('Reasoning') ?? '').includes('Thinking:ON')
    return {
      rawId,
      displayName: null,
      activity: 'chat',
      contextWindow: window,
      maxOutput: null,
      pricing: null,
      // Only the published media inputs are known; output is not stated by this table.
      modalities: input ? { input, output: null } : null,
      capabilities: thinks ? ['reasoning'] : null,
      reasoning: control,
      requestMap: null,
      providerMetadata: Object.fromEntries(
        [...cells].map(([label, raw]) => [label, text(raw)]),
      ),
      factSources: {
        ...(window !== null
          ? {
              contextWindow: {
                ...source,
                path: `Model ID=${rawId}; Context window`,
              },
            }
          : {}),
        ...(input
          ? {
              modalities: {
                ...source,
                path: `Model ID=${rawId}; Multimodal input`,
              },
            }
          : {}),
        ...(control
          ? { reasoning: { ...source, path: `Model ID=${rawId}; Reasoning` } }
          : {}),
        ...(thinks
          ? {
              capabilities: {
                reasoning: { ...source, path: `Model ID=${rawId}; Reasoning` },
              },
            }
          : {}),
      },
    }
  })
}
