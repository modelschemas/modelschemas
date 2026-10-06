/**
 * NVIDIA NIM — ids from the provider's public models list, facts from each
 * model's card on build.nvidia.com.
 *
 * The list publishes id and created only. A card's markdown twin
 * (`build.nvidia.com/<id>.md`) names the route the model is served on in
 * its Prototype section, and newer cards carry `## Specifications`
 * (context length, input, output) and `## Capabilities` bullet lists.
 * Older cards state those in prose that changes shape; it is not parsed.
 * NVIDIA publishes no per-token price for the hosted trial API.
 */
import type { Activity } from '#/db/schema.ts'

import { tagDocsFacts } from '../fact-sources.ts'
import {
  assertParsed,
  cachedDocs,
  mapConcurrent,
  markdownSection,
  tokenCount,
  tryDocs,
  unavailable,
} from '../model-facts.ts'
import { fetchJson, sha256Text } from '../types.ts'
import type {
  DocsFailure,
  ListModelsResult,
  ModelInfo,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

export const NVIDIA_MODELS_URL = 'https://integrate.api.nvidia.com/v1/models'
export const NVIDIA_CARD_BASE = 'https://build.nvidia.com/'

// A card renders in about ten seconds.
const CARD_TIMEOUT_MS = 60_000

const SPEC_SKIP =
  'nvidia: per-model OpenAPI documents (docs.api.nvidia.com/nim/reference) are not synced yet — skipped'

const CAPABILITY_FLAGS: Record<string, string> = {
  'Function Calling': 'tools',
  'Structured Output': 'structured_outputs',
  Reasoning: 'reasoning',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseNvidiaModels(payload: unknown): Array<ModelInfo> {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error('nvidia: models payload has no data array')
  }
  const models: Array<ModelInfo> = []
  for (const row of payload.data) {
    if (!isRecord(row) || typeof row.id !== 'string' || row.id.length === 0) {
      continue
    }
    models.push({
      rawId: row.id,
      releasedAt:
        typeof row.created === 'number' && row.created > 0 ? row.created : null,
      pricing: null,
    })
  }
  if (models.length === 0) {
    throw new Error('nvidia: models payload listed no ids')
  }
  return models
}

type CardFacts = Pick<
  ModelInfo,
  'activity' | 'contextWindow' | 'modalities' | 'capabilities'
>

const CARD_FACTS: Array<keyof CardFacts> = [
  'activity',
  'contextWindow',
  'modalities',
  'capabilities',
]

/** `- **Label:** value` lines of one card section. */
function bullets(markdown: string, heading: string): Map<string, string> {
  return new Map(
    [
      ...markdownSection(markdown, heading).matchAll(
        /^- \*\*(.+?):\*\* (.+)$/gm,
      ),
    ].map((match) => [match[1] ?? '', (match[2] ?? '').trim()]),
  )
}

function modalityList(cell: string | undefined): Array<string> {
  return (cell ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
}

/** The facts one model card states. Absent sections leave their facts out. */
export function parseNvidiaCard(markdown: string): CardFacts {
  const prototype = markdownSection(markdown, 'Prototype')
  const activity: Activity | null = prototype.includes(
    'integrate.api.nvidia.com/v1/chat/completions',
  )
    ? 'chat'
    : /api\.nvidia\.com\/v1\/\S*embeddings/.test(prototype)
      ? 'embeddings'
      : null
  const specs = bullets(markdown, 'Specifications')
  const input = modalityList(specs.get('Input'))
  const output = modalityList(specs.get('Output'))
  const capabilities = bullets(markdown, 'Capabilities')
  const contextWindow = tokenCount(specs.get('Context Length'))
  return {
    activity,
    ...(contextWindow ? { contextWindow } : {}),
    ...(input.length > 0 && output.length > 0
      ? { modalities: { input, output } }
      : {}),
    ...(capabilities.size > 0
      ? {
          capabilities: [...capabilities].flatMap(([label, value]) => {
            const flag = CAPABILITY_FLAGS[label]
            return flag && value === 'Supported' ? [flag] : []
          }),
        }
      : {}),
  }
}

/**
 * Card slugs keep the id, or write its dots as `_` or `-`
 * (`z-ai/glm-5.3` is at `z-ai/glm-5-3`). NVIDIA publishes no id-to-slug
 * map, so try each; a listed id with no card gets no facts.
 */
function cardSlugs(rawId: string): Array<string> {
  return [
    ...new Set([rawId, rawId.replaceAll('.', '_'), rawId.replaceAll('.', '-')]),
  ]
}

async function fetchCard(
  rawId: string,
): Promise<{ url: string; markdown: string; hash: string } | { url: null }> {
  for (const slug of cardSlugs(rawId)) {
    const url = `${NVIDIA_CARD_BASE}${slug}`
    // Providers poll in sequence; a hung card must not stall the rest.
    const response = await fetch(`${url}.md`, {
      signal: AbortSignal.timeout(CARD_TIMEOUT_MS),
    })
    if (response.status === 404) continue
    if (!response.ok) {
      throw new Error(
        `fetch failed: ${url}.md → ${String(response.status)} ${response.statusText}`,
      )
    }
    const markdown = await response.text()
    if (!markdown.startsWith('---\n')) {
      // Some cards have no markdown twin: the site answers 200 with its
      // HTML not-found page. Any other body is a failed load, never a card.
      if (markdown.includes('NEXT_HTTP_ERROR_FALLBACK;404')) continue
      throw new Error(`nvidia: ${url}.md is not a markdown card`)
    }
    // The slug is a guess, so the card must name itself as that page.
    if (!markdown.includes(`\ncanonical: "${url}"\n`)) continue
    return { url, markdown, hash: await sha256Text(markdown) }
  }
  return { url: null }
}

async function listModels(
  _env: ProviderSecrets,
  kv?: KVNamespace,
): Promise<ListModelsResult> {
  const listed = parseNvidiaModels(await fetchJson(NVIDIA_MODELS_URL))
  // A card takes about ten seconds to render. The six-hour cache per card
  // (misses included) keeps that off most polls.
  // A card that fails to load is that model's alone: its row keeps the
  // stored card facts and the next poll retries.
  const docsFailures: Array<DocsFailure> = []
  const models = await mapConcurrent(
    listed,
    8,
    async (model): Promise<ModelInfo> => {
      const source = `${NVIDIA_CARD_BASE}${model.rawId}.md`
      const patch = await tryDocs(docsFailures, source, async () => {
        const card = await cachedDocs(kv, source, () => fetchCard(model.rawId))
        if (card.url === null) return {}
        const facts = parseNvidiaCard(card.markdown)
        return {
          ...facts,
          factSources: tagDocsFacts(facts, card.url, card.hash),
        }
      })
      return { ...model, ...(patch ?? unavailable(...CARD_FACTS)) }
    },
  )
  const parsed = new Map(
    models.flatMap((model) => (model.activity ? [[model.rawId, model]] : [])),
  )
  // Zero rows with every card loaded is a reshaped site. With cards
  // failing it is the outage `docsFailures` already reports.
  if (parsed.size > 0 || docsFailures.length === 0) {
    assertParsed(parsed, 'nvidia model cards')
  }
  return { models, docsFailures }
}

function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  return Promise.resolve({
    specs: [],
    sources: [],
    outputStrategy: 'post-200',
    skipped: SPEC_SKIP,
  })
}

export const provider: ProviderConfig = {
  id: 'nvidia',
  displayName: 'NVIDIA NIM',
  specSourceUrl: 'https://docs.api.nvidia.com/nim/',
  modelsEndpoint: NVIDIA_MODELS_URL,
  defaultDerivation: 'docs-derived',
  fetchSpec,
  listModels,
  classify: () => null,
}
