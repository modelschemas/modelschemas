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
 * A price that is not settled is `absent: cleared`, not just null: the
 * listing was read and says so, so the poller drops a stored card once the
 * providers stop agreeing instead of keeping it as a parser miss. A price
 * that could not be read is never `cleared`: one odd entry makes its row's
 * price `unavailable` (the stored card stays) and is reported as a docs
 * failure, and a listing-wide change throws (`UNREAD_PRICE_SHARE`).
 *
 * The request schema is Hugging Face's own chat-completion JSON Schema
 * (huggingface.js `tasks`), wrapped into one OpenAPI path at sync time.
 * It is `generated`, so its fields are not walked onto rows: a shared
 * router schema does not show that every routed model accepts every field.
 */
import type { Activity } from '#/db/schema.ts'

import { hyperbolicListingCard } from '../catalog-prices.ts'
import { bearerConnect } from '../connect.ts'
import { docsReport, docsRun, tryDocs } from '../model-facts.ts'
import type { DocsRun } from '../model-facts.ts'
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

/**
 * Every provider entry. A list in another shape throws: read as "no
 * providers" it would say the price is gone and clear a stored card.
 */
function routes(providers: unknown): Array<Row> {
  if (Array.isArray(providers) && providers.every(isRecord)) return providers
  throw new Error('huggingface: a providers list is in an unread shape')
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

/** The listing carries float noise (`0.030000000000000002`). */
const exact = (n: number) => Number(n.toPrecision(12))

/**
 * USD per million tokens, or null when the entry states no price: its
 * `pricing` is missing or null, quotes zero, or is an `is_free` promo (not
 * the standard price). A `pricing` in any other shape throws. Null means
 * "unsettled" and clears a stored card, so it must never mean "could not
 * read".
 */
function price(p: Row): { input: number; output: number } | null {
  if (p.pricing == null) return null
  const { input, output } = isRecord(p.pricing) ? p.pricing : {}
  if (
    typeof input !== 'number' ||
    typeof output !== 'number' ||
    !(input >= 0 && output >= 0)
  ) {
    throw new Error(
      `huggingface: the price of provider entry ${JSON.stringify(p.provider)} is in an unread shape`,
    )
  }
  return p.is_free !== true && input > 0 && output > 0
    ? { input: exact(input), output: exact(output) }
    : null
}

const flag = (key: string) => (p: Row) => {
  const value = p[key]
  return typeof value === 'boolean' ? value : null
}

function listed(path: string): FactSource {
  return { derivation: 'listing', sourceUrl: HUGGINGFACE_MODELS_URL, path }
}

async function routeFacts(
  rawId: string,
  route: Array<Row>,
  run: DocsRun,
): Promise<
  Pick<
    ModelInfo,
    'contextWindow' | 'pricing' | 'capabilities' | 'factSources' | 'absent'
  >
> {
  const contextWindow = agreed(route, contextLength)
  // One entry whose price cannot be read withholds this row's price only.
  const read = await tryDocs(run, `${HUGGINGFACE_MODELS_URL}#${rawId}`, () =>
    Promise.resolve().then(() => ({ quote: agreed(route, price) })),
  )
  const quote = read?.quote ?? null
  const pricing = quote
    ? await hyperbolicListingCard(
        quote.input,
        quote.output,
        HUGGINGFACE_MODELS_URL,
      )
    : null
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
  if (pricing !== null) factSources.pricing = listed('providers[].pricing')
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
  return {
    contextWindow,
    pricing,
    capabilities,
    factSources,
    ...(pricing === null
      ? { absent: { pricing: read ? 'cleared' : 'unavailable' } }
      : {}),
  }
}

/**
 * When more than this share of the entries that carry a `pricing` value
 * cannot be read, the listing has changed shape: throw, so the poll fails
 * and no price moves. At or under it the odd entries are theirs alone.
 */
const UNREAD_PRICE_SHARE = 0.1

export async function parseHuggingFaceModels(
  payload: unknown,
): Promise<Required<Pick<ListModelsResult, 'models' | 'docsFailures'>>> {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error('huggingface: models payload has no data array')
  }
  const models: Array<ModelInfo> = []
  const run = docsRun()
  let stated = 0
  let unread = 0
  let quotes = 0
  for (const row of payload.data) {
    if (!isRecord(row) || typeof row.id !== 'string' || row.id.length === 0) {
      continue
    }
    const route = routes(row.providers)
    for (const p of route) {
      if (p.pricing == null) continue
      stated++
      try {
        if (price(p) !== null) quotes++
      } catch {
        unread++
      }
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
      ...(await routeFacts(row.id, route, run)),
      releasedAt:
        typeof row.created === 'number' && row.created > 0 ? row.created : null,
    })
  }
  if (models.length === 0) {
    throw new Error('huggingface: models payload listed no ids')
  }
  // Most entries quote a price. None at all is a listing that moved its
  // prices, not a router where every host stopped charging.
  if (unread > stated * UNREAD_PRICE_SHARE) {
    throw new Error(
      `huggingface: ${String(unread)} of ${String(stated)} provider prices are in an unread shape`,
    )
  }
  if (quotes === 0) {
    throw new Error('huggingface: no provider entry states a price')
  }
  return { models, docsFailures: docsReport(run) }
}

async function listModels(_env: ProviderSecrets): Promise<ListModelsResult> {
  const payload = await fetchJson(HUGGINGFACE_MODELS_URL, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  return parseHuggingFaceModels(payload)
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
