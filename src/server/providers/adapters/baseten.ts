/**
 * Baseten Model APIs. The catalog is `GET /v1/models` on the inference host.
 * That list publishes id, context, modalities, and per-token prices. It
 * requires `BASETEN_API_KEY`; a missing key skips so stored rows stay.
 * Effort values come from the public reasoning page's depth table, joined by
 * display name; its effective-depth column says what `none` does.
 * A zero price string is not a rate. Schemas are the published OpenAPI files.
 */
import { compileTokenCard } from '@modelschemas/rate-card'
import type { RateCard } from '@modelschemas/rate-card'

import type { Activity } from '#/db/schema.ts'

import { fetchOpenApi, fetchText, sha256Text, skippedResult } from '../types.ts'
import type {
  FactSource,
  ListModelsResult,
  ModelInfo,
  ModelReasoning,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

export const BASETEN_MODELS_URL = 'https://inference.baseten.co/v1/models'
export const BASETEN_REASONING_URL =
  'https://docs.baseten.co/inference/model-apis/reasoning.md'
export const BASETEN_CHAT_OPENAPI_URL =
  'https://docs.baseten.co/reference/inference-api/llm-openapi-spec.json'
export const BASETEN_MESSAGES_OPENAPI_URL =
  'https://docs.baseten.co/reference/inference-api/messages-openapi-spec.json'

const CHAT_ENDPOINT = 'v1/chat/completions'

interface TokenQuote {
  input: number
  output: number
  cache: number | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cells(line: string): Array<string> | null {
  if (!line.startsWith('|')) return null
  const row = line
    .split('|')
    .slice(1, -1)
    .map((cell) => cell.trim())
  if (row.length === 0 || row.every((cell) => /^:?-+:?$/.test(cell)))
    return null
  return row
}

function positiveRate(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function stringList(value: unknown): Array<string> | null {
  if (!Array.isArray(value) || value.length === 0) return null
  const out: Array<string> = []
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0) return null
    out.push(item)
  }
  return out
}

function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : null
}

const DEPTH_HEADING = /^(#{2,3}) (?:Control|Set) reasoning depth[ \t]*$/m

/**
 * The page states `none` turns reasoning off on every row that lists it
 * unless the row's effective depth says otherwise. `none` running at a
 * level is a stated always-on, and the row holds that level instead of
 * `none`; any other word on `none` is unstated.
 */
function effortReasoning(values: Array<string>, depth: string): ModelReasoning {
  if (!values.includes('none')) {
    return { mode: 'effort', mandatory: true, efforts: values }
  }
  const runsAt = /`none` runs at `([^`]+)`/.exec(depth)?.[1]
  if (runsAt) {
    return {
      mode: 'effort',
      mandatory: true,
      efforts: [
        ...new Set(values.map((value) => (value === 'none' ? runsAt : value))),
      ],
    }
  }
  const mandatory =
    !depth.includes('`none`') || /`none` turns reasoning off/.test(depth)
      ? false
      : null
  return { mode: 'effort', mandatory, efforts: values }
}

function parseEfforts(markdown: string): Map<string, ModelReasoning> {
  const heading = DEPTH_HEADING.exec(markdown)
  if (!heading) {
    throw new Error('baseten: reasoning page has no effort table')
  }
  const rest = markdown.slice(heading.index + heading[0].length)
  const next = rest.search(new RegExp(`^#{1,${heading[1]?.length ?? 2}} `, 'm'))
  const section = next < 0 ? rest : rest.slice(0, next)
  const efforts = new Map<string, ModelReasoning>()
  let valuesColumn = -1
  let depthColumn = -1
  for (const line of section.split('\n')) {
    const row = cells(line)
    if (!row) continue
    if (row[0] === 'Model') {
      valuesColumn = row.indexOf('Supported values')
      depthColumn = row.indexOf('Effective depth')
      continue
    }
    if (valuesColumn < 0) continue
    const values = (row[valuesColumn] ?? '')
      .replace(/\(default\)/gi, '')
      .split(',')
      .map((value) => value.replace(/`/g, '').trim())
      .filter((value) => value.length > 0)
    if (values.length === 0) continue
    efforts.set(
      row[0] ?? '',
      effortReasoning(values, depthColumn < 0 ? '' : (row[depthColumn] ?? '')),
    )
  }
  if (efforts.size === 0) {
    throw new Error('baseten: reasoning page listed no efforts')
  }
  return efforts
}

function quoteFor(pricing: unknown): TokenQuote | null {
  if (!isRecord(pricing)) return null
  const input = positiveRate(pricing.prompt)
  const output = positiveRate(pricing.completion)
  if (input === null || output === null) return null
  return { input, output, cache: positiveRate(pricing.input_cache_read) }
}

function activityFor(output: Array<string> | null): Activity | null {
  if (!output) return null
  if (output.includes('text')) return 'chat'
  if (output.includes('image')) return 'image'
  if (output.includes('audio')) return 'audio'
  return null
}

/** Rows from `GET /v1/models`. Efforts join by the row's display name. */
export function parseBasetenModels(
  payload: unknown,
  reasoningMarkdown: string,
  source: RateCard['source'],
  reasoningHash: string,
): Array<ModelInfo> {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error('baseten: models payload has no data array')
  }
  const efforts = parseEfforts(reasoningMarkdown)
  const models: Array<ModelInfo> = []
  for (const row of payload.data) {
    if (!isRecord(row) || typeof row.id !== 'string' || row.id.length === 0) {
      continue
    }
    const name = typeof row.name === 'string' ? row.name : null
    const quote = quoteFor(row.pricing)
    const pricing = quote
      ? compileTokenCard(
          {
            input_tokens: quote.input,
            output_tokens: quote.output,
            ...(quote.cache !== null ? { cache_read_tokens: quote.cache } : {}),
          },
          [],
          source,
        )
      : null
    const reasoning = name ? (efforts.get(name) ?? null) : null
    const input = stringList(row.input_modalities)
    const output = stringList(row.output_modalities)
    const reasoningSource: FactSource | undefined = reasoning
      ? {
          derivation: 'docs-derived',
          sourceUrl: BASETEN_REASONING_URL,
          sourceHash: reasoningHash,
          path: 'reasoning_effort',
        }
      : undefined
    models.push({
      rawId: row.id,
      displayName: name,
      activity: activityFor(output),
      contextWindow: positiveInt(row.context_length),
      maxOutput: positiveInt(row.max_completion_tokens),
      modalities: input && output ? { input, output } : null,
      pricing,
      reasoning,
      releasedAt: positiveInt(row.created),
      ...(reasoningSource
        ? { factSources: { reasoning: reasoningSource } }
        : {}),
    })
  }
  if (models.length === 0) {
    throw new Error('baseten: models payload listed no ids')
  }
  return models
}

async function listModels(env: ProviderSecrets): Promise<ListModelsResult> {
  const key = env.BASETEN_API_KEY
  if (!key)
    return { models: [], ...skippedResult('baseten', 'BASETEN_API_KEY') }
  const [modelsText, reasoning] = await Promise.all([
    fetchText(BASETEN_MODELS_URL, {
      headers: { Authorization: `Bearer ${key}` },
    }),
    fetchText(BASETEN_REASONING_URL),
  ])
  const [modelsHash, reasoningHash] = await Promise.all([
    sha256Text(modelsText),
    sha256Text(reasoning),
  ])
  return {
    models: parseBasetenModels(
      JSON.parse(modelsText) as unknown,
      reasoning,
      {
        url: BASETEN_MODELS_URL,
        hash: modelsHash,
        extractedAt: new Date().toISOString(),
      },
      reasoningHash,
    ),
  }
}

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const [chat, messages] = await Promise.all([
    fetchOpenApi(BASETEN_CHAT_OPENAPI_URL),
    fetchOpenApi(BASETEN_MESSAGES_OPENAPI_URL),
  ])
  return {
    specs: [chat.spec, messages.spec],
    sources: [
      { url: BASETEN_CHAT_OPENAPI_URL, hash: chat.hash },
      { url: BASETEN_MESSAGES_OPENAPI_URL, hash: messages.hash },
    ],
    outputStrategy: 'post-200',
    specRevision: chat.hash,
  }
}

export function classifyBasetenPath(path: string): Activity | null {
  const bare = path.replace(/^\//, '')
  if (bare === CHAT_ENDPOINT || bare === 'v1/messages') return 'chat'
  return null
}

export const provider: ProviderConfig = {
  id: 'baseten',
  displayName: 'Baseten',
  authEnvVar: 'BASETEN_API_KEY',
  specSourceUrl: BASETEN_CHAT_OPENAPI_URL,
  modelsEndpoint: BASETEN_MODELS_URL,
  defaultDerivation: 'upstream-spec',
  fetchSpec,
  listModels,
  classify: (path) => classifyBasetenPath(path),
  generationEndpointId: ({ activity }) =>
    activity === 'chat' ? CHAT_ENDPOINT : null,
}
