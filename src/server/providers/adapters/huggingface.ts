/**
 * Hugging Face Inference Providers — the public router model list.
 *
 * A router row is served by several hosts, each with its own context
 * length, price, and tool support. The default route is the fastest one by
 * a live probe figure, and a caller can also ask for the cheapest, their
 * preferred, or a named provider. So a fact is stored only when every entry
 * in `providers[]` states it and they all agree — the value then holds on
 * any route. A provider that states nothing (a missing figure means no
 * probe data, not unroutable) leaves the fact null. No provider is picked,
 * and nothing is averaged. Field meanings and units:
 * https://huggingface.co/docs/inference-providers/hub-api
 *
 * Prices stay null although the listing has them. The poller keeps a stored
 * card when a later poll has no price (`observePricingWrite`), so a row whose
 * providers stop agreeing would serve a stale price. Add them back once the
 * poller can tell "source failed" from "source says unsettled".
 *
 * The request schema is Hugging Face's own chat-completion JSON Schema
 * (huggingface.js `tasks`), wrapped into one OpenAPI path at sync time.
 * It is `generated`, so its fields are not walked onto rows: a shared
 * router schema does not show that every routed model accepts every field.
 */
import type { Activity } from '#/db/schema.ts'

import { bearerConnect } from '../connect.ts'
import { fetchJson, fetchText, sha256Text } from '../types.ts'
import type {
  FactSource,
  ListModelsResult,
  ModelFactSources,
  ModelInfo,
  OpenApiDocument,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

export const HUGGINGFACE_MODELS_URL = 'https://router.huggingface.co/v1/models'
const SPEC_DIR = 'packages/tasks/src/tasks/chat-completion/spec'
/** The two files `fetchSpec` reads: `input.json` and `output.json`. */
export const HUGGINGFACE_SPEC_RAW_URL = `https://raw.githubusercontent.com/huggingface/huggingface.js/main/${SPEC_DIR}`
export const HUGGINGFACE_SPEC_URL = `https://github.com/huggingface/huggingface.js/tree/main/${SPEC_DIR}`

const SERVER_URL = 'https://router.huggingface.co'
const CHAT_PATH = '/v1/chat/completions'
const FETCH_TIMEOUT_MS = 30_000

type Row = Record<string, unknown>

function isRecord(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringList(value: unknown): Array<string> | null {
  if (!Array.isArray(value) || value.length === 0) return null
  const out: Array<string> = []
  for (const item of value) {
    if (typeof item !== 'string') return null
    out.push(item)
  }
  return out
}

function activityFor(output: Array<string> | null): Activity | null {
  if (!output) return null
  if (output.includes('image') && !output.includes('text')) return 'image'
  if (output.includes('text')) return 'chat'
  if (output.includes('embedding') || output.includes('embeddings')) {
    return 'embeddings'
  }
  if (output.includes('audio')) return 'audio'
  return null
}

/** Every provider entry. Empty when the list is malformed. */
function routes(providers: unknown): Array<Row> {
  return Array.isArray(providers) && providers.every(isRecord) ? providers : []
}

/** The one value every provider states, or null. */
function agreed<T>(route: Array<Row>, read: (p: Row) => T | null): T | null {
  const [first, ...rest] = route.map(read)
  if (first === undefined || first === null) return null
  const key = JSON.stringify(first)
  return rest.every((value) => JSON.stringify(value) === key) ? first : null
}

function contextLength(p: Row): number | null {
  const n = p.context_length
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null
}

const flag = (key: string) => (p: Row) => {
  const value = p[key]
  return typeof value === 'boolean' ? value : null
}

function listed(path: string): FactSource {
  return { derivation: 'listing', sourceUrl: HUGGINGFACE_MODELS_URL, path }
}

function routeFacts(
  providers: unknown,
): Pick<ModelInfo, 'contextWindow' | 'capabilities' | 'factSources'> {
  const route = routes(providers)
  const contextWindow = agreed(route, contextLength)
  // The flag list reads "absent = unsupported", so it is stored only when
  // both flags are settled.
  const tools = agreed(route, flag('supports_tools'))
  const structured = agreed(route, flag('supports_structured_output'))
  const capabilities =
    tools === null || structured === null
      ? null
      : [
          ...(tools ? ['tools'] : []),
          ...(structured ? ['structured_outputs', 'response_format'] : []),
        ]

  const factSources: ModelFactSources = {}
  if (contextWindow !== null) {
    factSources.contextWindow = listed('providers[].context_length')
  }
  if (capabilities && capabilities.length > 0) {
    factSources.capabilities = Object.fromEntries(
      capabilities.map((name) => [
        name,
        listed(
          name === 'tools'
            ? 'providers[].supports_tools'
            : 'providers[].supports_structured_output',
        ),
      ]),
    )
  }
  return { contextWindow, capabilities, factSources }
}

export function parseHuggingFaceModels(payload: unknown): Array<ModelInfo> {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error('huggingface: models payload has no data array')
  }
  const models: Array<ModelInfo> = []
  for (const row of payload.data) {
    if (!isRecord(row) || typeof row.id !== 'string' || row.id.length === 0) {
      continue
    }
    const architecture = isRecord(row.architecture) ? row.architecture : null
    const input = architecture
      ? stringList(architecture.input_modalities)
      : null
    const output = architecture
      ? stringList(architecture.output_modalities)
      : null
    models.push({
      rawId: row.id,
      activity: activityFor(output),
      modalities: input && output ? { input, output } : null,
      pricing: null,
      ...routeFacts(row.providers),
      releasedAt:
        typeof row.created === 'number' && row.created > 0 ? row.created : null,
    })
  }
  if (models.length === 0) {
    throw new Error('huggingface: models payload listed no ids')
  }
  return models
}

async function listModels(_env: ProviderSecrets): Promise<ListModelsResult> {
  const payload = await fetchJson(HUGGINGFACE_MODELS_URL, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  return { models: parseHuggingFaceModels(payload) }
}

/**
 * One published schema file as OpenAPI components: the root under `title`,
 * its `$defs` beside it. Throws on anything that is not that file.
 */
function components(
  text: string,
  title: string,
  property: string,
): Record<string, unknown> {
  let schema: unknown
  try {
    schema = JSON.parse(text.replaceAll('"#/$defs/', '"#/components/schemas/'))
  } catch {
    throw new Error(`huggingface: ${title} schema is not JSON`)
  }
  if (
    !isRecord(schema) ||
    schema.title !== title ||
    !isRecord(schema.properties) ||
    !isRecord(schema.properties[property]) ||
    !isRecord(schema.$defs) ||
    title in schema.$defs
  ) {
    throw new Error(`huggingface: ${title} schema has an unexpected shape`)
  }
  const { $id: _id, $schema: _draft, $defs: defs, ...root } = schema
  return { ...defs, [title]: root }
}

export function buildHuggingFaceSpec(
  inputText: string,
  outputText: string,
): OpenApiDocument {
  const input = components(inputText, 'ChatCompletionInput', 'messages')
  const output = components(outputText, 'ChatCompletionOutput', 'choices')
  const clash = Object.keys(input).filter((name) => name in output)
  if (clash.length > 0) {
    throw new Error(`huggingface: schema name clash: ${clash.join(', ')}`)
  }
  const json = (name: string) => ({
    'application/json': { schema: { $ref: `#/components/schemas/${name}` } },
  })
  return {
    openapi: '3.1.0',
    info: { title: 'Hugging Face Inference Providers', version: '1' },
    servers: [{ url: SERVER_URL }],
    paths: {
      [CHAT_PATH]: {
        post: {
          operationId: 'chatCompletion',
          summary: 'Chat Completion',
          requestBody: { required: true, content: json('ChatCompletionInput') },
          responses: {
            '200': {
              description: 'Chat Completion Output',
              content: json('ChatCompletionOutput'),
            },
          },
        },
      },
    },
    components: { schemas: { ...input, ...output } },
  }
}

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const file = (name: string) =>
    fetchText(`${HUGGINGFACE_SPEC_RAW_URL}/${name}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  const [input, output] = await Promise.all([
    file('input.json'),
    file('output.json'),
  ])
  // One document from two files: the hash is of their concatenation.
  const hash = await sha256Text(`${input}${output}`)
  return {
    specs: [buildHuggingFaceSpec(input, output)],
    sources: [{ url: HUGGINGFACE_SPEC_URL, hash }],
    outputStrategy: 'post-200',
    specRevision: hash,
  }
}

export const provider: ProviderConfig = {
  id: 'huggingface',
  displayName: 'Hugging Face',
  specSourceUrl: HUGGINGFACE_SPEC_URL,
  modelsEndpoint: HUGGINGFACE_MODELS_URL,
  defaultDerivation: 'generated',
  connect: bearerConnect(SERVER_URL),
  fetchSpec,
  listModels,
  classify: (path) => (path === CHAT_PATH ? 'chat' : null),
  generationEndpointId: ({ activity }) =>
    activity === 'chat' ? CHAT_PATH.slice(1) : null,
}
