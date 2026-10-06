/**
 * Perplexity — public OpenAPI 3.1 spec at docs.perplexity.ai/openapi.json.
 * Generation is Sonar (`/v1/sonar`) and the Agent API (`/v1/agent`), plus
 * embeddings. Search, async jobs, files/cancel, and analytics are platform.
 */
import type { Activity } from '#/db/schema.ts'
import { perplexityListingCard } from '../catalog-prices.ts'
import {
  cachedDocs,
  docsReport,
  docsRun,
  markdownTableRows,
  tryDocs,
  unavailable,
} from '../model-facts.ts'
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
const PERPLEXITY_PRESETS_DOC_URL =
  'https://docs.perplexity.ai/docs/agent-api/presets.md'
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

/** Model id → the capability flags one docs page states for it. */
type StatedFlags = Map<string, Array<string>>

function addFlags(out: StatedFlags, id: string, flags: Array<string>): void {
  out.set(id, [...new Set([...(out.get(id) ?? []), ...flags])])
}

/** Tab and accordion bodies are indented; rows and bullets start the line. */
function dedent(text: string): string {
  return text.replace(/^[ \t]+/gm, '')
}

/**
 * Flags the Agent API models page states, per model id. Each provider tab
 * holds a card, a model table and, for some models, an `<Info>` sentence.
 *
 * - "Kimi K3 accepts `minimal`, … and `max` reasoning effort." gives
 *   `reasoning` and `reasoning_effort` to the row whose link text is the
 *   name. The page does not say whether reasoning can be turned off, so no
 *   `reasoning` object is built from the list.
 * - A card that ends "… reasoning model(s)." gives `reasoning` to every row
 *   of its tab, and only when it names as many models as the tab lists.
 *
 * Any other wording of either statement throws, as does an effort sentence
 * outside the tabs or a second one for the same model.
 */
export function parsePerplexityModelsPage(markdown: string): StatedFlags {
  const stated: StatedFlags = new Map()
  const unread = (what: string) =>
    new Error(`perplexity: models page states ${what} in an unread shape`)
  let rows = 0
  let sentences = 0
  for (const chunk of markdown.split('<Tab title="').slice(1)) {
    const tab = dedent(chunk.split('</Tab>')[0] ?? '')
    const table = markdownTableRows(tab).filter((row) =>
      /^`[^`]+`$/.test(row[0] ?? ''),
    )
    const ids = table.map((row) => (row[0] ?? '').slice(1, -1))
    rows += ids.length

    const card = /<Card title="[^"]*">\n([^]*?)\n<\/Card>/.exec(tab)?.[1] ?? ''
    if (/reasoning models?\b/i.test(card)) {
      const subject =
        /^(.+?) (?:—|is) .*\breasoning models?\.$/.exec(card)?.[1] ?? ''
      const names = subject.split(/, and |, | and /)
      if (
        subject === '' ||
        names.length !== ids.length ||
        /\b(?:not|no|non)\b/i.test(card)
      ) {
        throw unread('a reasoning model')
      }
      for (const id of ids) addFlags(stated, id, ['reasoning'])
    }

    const efforts = [
      ...tab.matchAll(
        /^(\S.*?) accepts (?:`[a-z]+`(?:, and |, | and )?)+ reasoning effort\./gm,
      ),
    ]
    sentences += efforts.length
    const seen = new Set<string>()
    for (const [, name] of efforts) {
      const named = table.filter((cells) =>
        cells.at(-1)?.startsWith(`[${name ?? ''}](`),
      )
      const id = named.length === 1 ? named[0]?.[0]?.slice(1, -1) : undefined
      if (!id || seen.has(id)) throw unread('reasoning effort')
      seen.add(id)
      addFlags(stated, id, ['reasoning', 'reasoning_effort'])
    }
  }
  if (rows === 0) throw new Error('perplexity: models page lists no models')
  if (sentences !== (markdown.match(/reasoning effort/gi) ?? []).length) {
    throw unread('reasoning effort')
  }
  return stated
}

/**
 * Flags the presets page states in its "current preset values" accordions:
 * each preset names its model, the `reasoning.effort` it sends, and its tools. A model
 * a preset runs with an effort takes `reasoning.effort`; one it runs with
 * tools takes `tools`. The page says nothing of `tool_choice`.
 */
export function parsePerplexityPresets(markdown: string): StatedFlags {
  const stated: StatedFlags = new Map()
  // Not cut by `## ` heading: the preset prompts hold headings of their own.
  for (const chunk of markdown.split('<Accordion title="').slice(1)) {
    if (!/^[^"\n]* — current preset values">/.test(chunk)) continue
    const body = dedent(chunk.split('</Accordion>')[0] ?? '')
    const bullet = (label: string): string | null => {
      const lines = [
        ...body.matchAll(new RegExp(`^\\* \\*\\*${label}:\\*\\* (.*)$`, 'gm')),
      ]
      if (lines.length > 1) {
        throw new Error(`perplexity: preset states ${label} twice`)
      }
      return lines[0]?.[1] ?? null
    }
    const model = /^`([^`\s]+)`$/.exec(bullet('Model') ?? '')?.[1]
    if (!model) throw new Error('perplexity: preset names no model')
    const effort = bullet('Reasoning effort')
    const tools = bullet('Tools')
    if (effort !== null) {
      if (!/^`[a-z]+`$/.test(effort)) {
        throw new Error('perplexity: preset effort is in an unread shape')
      }
      addFlags(stated, model, ['reasoning', 'reasoning_effort'])
    }
    if (tools !== null) {
      if (!/^`[a-z_]+`/.test(tools)) {
        throw new Error('perplexity: preset tools are in an unread shape')
      }
      addFlags(stated, model, ['tools'])
    }
  }
  if (stated.size === 0) {
    throw new Error('perplexity: presets page lists no preset models')
  }
  return stated
}

interface StatedDoc {
  hash: string
  flags: Array<[string, Array<string>]>
}

function statedDoc(
  kv: KVNamespace | undefined,
  url: string,
  parse: (markdown: string) => StatedFlags,
): Promise<StatedDoc> {
  return cachedDocs(kv, url, async () => {
    const text = await fetchText(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    return { hash: await sha256Text(text), flags: [...parse(text)] }
  })
}

/** The flags both pages state for one model, each with its page. */
function statedFacts(
  id: string,
  docs: Array<{ url: string; doc: StatedDoc }>,
): Pick<ModelInfo, 'capabilities' | 'factSources'> {
  const sources: Record<string, FactSource> = {}
  for (const { url, doc } of docs) {
    for (const flag of new Map(doc.flags).get(id) ?? []) {
      sources[flag] ??= {
        derivation: 'docs-derived',
        sourceUrl: url,
        sourceHash: doc.hash,
        path: flag,
      }
    }
  }
  const capabilities = Object.keys(sources)
  if (capabilities.length === 0) return {}
  return { capabilities, factSources: { capabilities: sources } }
}

type StatedFact = Exclude<keyof ReturnType<typeof statedFacts>, 'factSources'>

/**
 * Every fact `statedFacts` supplies; all are withheld when a page fails.
 * Keyed by its return type, so a fact added there fails to compile here
 * instead of going null on a docs failure.
 */
const STATED_FACTS: Record<StatedFact, true> = { capabilities: true }

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
  const run = docsRun()
  const [body, modelsPage, presets] = await Promise.all([
    fetchJson(PERPLEXITY_MODELS_URL, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    }) as Promise<PerplexityModelList>,
    tryDocs(run, PERPLEXITY_MODELS_DOC_URL, () =>
      statedDoc(kv, PERPLEXITY_MODELS_DOC_URL, parsePerplexityModelsPage),
    ),
    tryDocs(run, PERPLEXITY_PRESETS_DOC_URL, () =>
      statedDoc(kv, PERPLEXITY_PRESETS_DOC_URL, parsePerplexityPresets),
    ),
  ])
  // Both pages or neither: one page's flags alone would drop the other's.
  const docs =
    modelsPage && presets
      ? [
          { url: PERPLEXITY_MODELS_DOC_URL, doc: modelsPage },
          { url: PERPLEXITY_PRESETS_DOC_URL, doc: presets },
        ]
      : null
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
      ...(docs
        ? statedFacts(m.id, docs)
        : unavailable(...(Object.keys(STATED_FACTS) as Array<StatedFact>))),
    })
  }
  return { models, docsFailures: docsReport(run) }
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
  // tools)" — docs.perplexity.ai/docs/agent-api/models. These four are the
  // flags that sentence names; a row gets one back only from a docs page
  // that states it. Of the flags the walk keeps, only `max_tokens` is
  // stated as shared ("a shared Agent API parameter"). `temperature`,
  // `top_p`, `response_format` and `structured_outputs` are kept on
  // judgement: the sentence's "e.g." is open-ended and does not name them.
  perModelSchemaFlags: [
    'reasoning',
    'reasoning_effort',
    'tools',
    'tool_choice',
  ],
}
