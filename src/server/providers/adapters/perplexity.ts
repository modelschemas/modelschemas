/**
 * Perplexity — public OpenAPI 3.1 spec at docs.perplexity.ai/openapi.json.
 * Generation is Sonar (`/v1/sonar`) and the Agent API (`/v1/agent`), plus
 * embeddings. Search, async jobs, files/cancel, and analytics are platform.
 */
import type { Activity } from '#/db/schema.ts'
import { perplexityListingCard } from '../catalog-prices.ts'
import { cachedDocs, markdownTableRows } from '../model-facts.ts'
import {
  fetchJson,
  fetchOpenApi,
  fetchText,
  sha256Text,
  skippedResult,
} from '../types.ts'
import type {
  FactSource,
  ListModelsResult,
  ModelInfo,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

const PERPLEXITY_OPENAPI_URL = 'https://docs.perplexity.ai/openapi.json'
const PERPLEXITY_MODELS_URL = 'https://api.perplexity.ai/v1/models'
const PERPLEXITY_MODELS_DOC_URL =
  'https://docs.perplexity.ai/docs/agent-api/models.md'
const FETCH_TIMEOUT_MS = 20_000

function classify(path: string): Activity | null {
  if (path === '/v1/sonar' || path === '/v1/agent') return 'chat'
  if (path === '/v1/embeddings' || path === '/v1/contextualizedembeddings') {
    return 'embeddings'
  }
  return null
}

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const { spec, hash } = await fetchOpenApi(PERPLEXITY_OPENAPI_URL)
  return {
    specs: [spec],
    sources: [{ url: PERPLEXITY_OPENAPI_URL, hash }],
    outputStrategy: 'post-200',
  }
}

/**
 * Model id → the reasoning efforts the Agent API models page says it
 * accepts. Each provider tab holds a model table and, for some models, an
 * `<Info>` sentence: "Kimi K3 accepts `minimal`, … and `max` reasoning
 * effort." The sentence names the model by the link text of its table row.
 * A tab that mentions reasoning effort in any other wording throws.
 */
export function parsePerplexityEfforts(
  markdown: string,
): Map<string, Array<string>> {
  const efforts = new Map<string, Array<string>>()
  let rows = 0
  for (const chunk of markdown.split('<Tab title="').slice(1)) {
    // Tab bodies are indented; table rows must start the line.
    const tab = (chunk.split('</Tab>')[0] ?? '').replace(/^[ \t]+/gm, '')
    const table = markdownTableRows(tab).filter((row) =>
      /^`[^`]+`$/.test(row[0] ?? ''),
    )
    rows += table.length
    const stated = [
      ...tab.matchAll(
        /^(\S.*?) accepts ((?:`[a-z]+`(?:, and |, | and )?)+) reasoning effort\./gm,
      ),
    ]
    const unread = new Error(
      'perplexity: models page states reasoning effort in an unread shape',
    )
    if (stated.length !== (tab.match(/reasoning effort/gi) ?? []).length) {
      throw unread
    }
    for (const [, name, list] of stated) {
      const named = table.filter((cells) =>
        cells.at(-1)?.startsWith(`[${name ?? ''}](`),
      )
      const id = named.length === 1 ? named[0]?.[0]?.slice(1, -1) : undefined
      if (!id || !list) throw unread
      efforts.set(
        id,
        [...list.matchAll(/`([a-z]+)`/g)].flatMap((m) => m[1] ?? []),
      )
    }
  }
  if (rows === 0) throw new Error('perplexity: models page lists no models')
  return efforts
}

async function loadEfforts(): Promise<{
  hash: string
  efforts: Array<[string, Array<string>]>
}> {
  const text = await fetchText(PERPLEXITY_MODELS_DOC_URL, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  return {
    hash: await sha256Text(text),
    efforts: [...parsePerplexityEfforts(text)],
  }
}

/**
 * The page states efforts only. A list without `none` has no off value, so
 * reasoning is mandatory. Whether a `none` turns it off is not stated, so a
 * list with one stores nothing.
 */
function reasoningFacts(
  efforts: Array<string> | undefined,
  source: FactSource,
): Pick<ModelInfo, 'capabilities' | 'reasoning' | 'factSources'> {
  if (!efforts || efforts.includes('none')) return {}
  return {
    capabilities: ['reasoning', 'reasoning_effort'],
    reasoning: { mode: 'effort', mandatory: true, efforts },
    factSources: {
      reasoning: source,
      capabilities: { reasoning: source, reasoning_effort: source },
    },
  }
}

interface PerplexityModelList {
  data?: Array<{ id: string; created?: number; pricing?: unknown }>
}

async function listModels(
  env: ProviderSecrets,
  kv?: KVNamespace,
): Promise<ListModelsResult> {
  const key = env.PERPLEXITY_API_KEY
  if (!key) {
    return { models: [], ...skippedResult('perplexity', 'PERPLEXITY_API_KEY') }
  }
  const [body, docs] = await Promise.all([
    fetchJson(PERPLEXITY_MODELS_URL, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    }) as Promise<PerplexityModelList>,
    cachedDocs(kv, PERPLEXITY_MODELS_DOC_URL, loadEfforts),
  ])
  const efforts = new Map(docs.efforts)
  const source: FactSource = {
    derivation: 'docs-derived',
    sourceUrl: PERPLEXITY_MODELS_DOC_URL,
    sourceHash: docs.hash,
    path: 'reasoning.effort',
  }
  const models: Array<ModelInfo> = []
  for (const m of body.data ?? []) {
    const pricing = await perplexityListingCard(
      m.pricing,
      PERPLEXITY_MODELS_URL,
    )
    models.push({
      rawId: m.id,
      releasedAt: m.created ?? null,
      activity: 'chat' as const,
      ...(pricing ? { pricing } : {}),
      ...reasoningFacts(efforts.get(m.id), source),
    })
  }
  return { models }
}

export const provider: ProviderConfig = {
  id: 'perplexity',
  displayName: 'Perplexity',
  authEnvVar: 'PERPLEXITY_API_KEY',
  specSourceUrl: PERPLEXITY_OPENAPI_URL,
  modelsEndpoint: PERPLEXITY_MODELS_URL,
  defaultDerivation: 'upstream-spec',
  fetchSpec,
  listModels,
  classify,
  // /v1/models lists Agent API ids; /v1/sonar answers 400 "Invalid model"
  // to `perplexity/sonar` and its spec enum holds only the bare Sonar ids.
  generationEndpointId: () => 'v1/agent',
  // "Not all third-party models support all features (e.g., reasoning,
  // tools)" — docs.perplexity.ai/docs/agent-api/models.
  perModelSchemaFlags: [
    'reasoning',
    'reasoning_effort',
    'tools',
    'tool_choice',
  ],
}
