/**
 * Cloudflare Workers AI — model cards from the public models page.
 * `data-model-id` is the caller id. A per-1M-token price is stored only
 * when that card names both input and output. Other units stay null.
 */
import { compileTokenCard } from '@modelschemas/rate-card'
import type { RateCard } from '@modelschemas/rate-card'

import type { Activity } from '#/db/schema.ts'

import { fetchText, sha256Text } from '../types.ts'
import type {
  ListModelsResult,
  ModelInfo,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

export const WORKERS_AI_MODELS_URL =
  'https://developers.cloudflare.com/workers-ai/models/'

const SPEC_SKIP =
  'cloudflare-workers-ai: no first-party OpenAPI document — skipped'

const TASK_ACTIVITY: Record<string, Activity> = {
  'Text Generation': 'chat',
  'Text-to-Image': 'image',
  'Text Embeddings': 'embeddings',
  'Text-to-Speech': 'audio',
  'Automatic Speech Recognition': 'audio',
}

function attr(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`\\b${name}="([^"]*)"`))
  return match?.[1] ? match[1] : null
}

function dollarsPerMillion(text: string, label: string): number | null {
  const match = text.match(
    new RegExp(`${label} \\(per 1M tokens\\): \\$([0-9]+(?:\\.[0-9]+)?)`),
  )
  if (!match?.[1]) return null
  const dollars = Number(match[1])
  return Number.isFinite(dollars) && dollars > 0 ? dollars / 1_000_000 : null
}

export function parseWorkersAiModels(
  html: string,
  source: RateCard['source'],
): Array<ModelInfo> {
  const models: Array<ModelInfo> = []
  const seen = new Set<string>()
  for (const match of html.matchAll(
    /<[^>]*?\bdata-model-id="([^"]+)"([\s\S]*?)>/g,
  )) {
    const rawId = match[1] ?? ''
    const tag = match[0]
    if (rawId.length === 0 || seen.has(rawId)) continue
    seen.add(rawId)
    const task = attr(tag, 'data-model-task')
    const context = attr(tag, 'data-model-context')
    const pricingText = attr(tag, 'data-model-pricing') ?? ''
    const input = dollarsPerMillion(pricingText, 'Input')
    const output = dollarsPerMillion(pricingText, 'Output')
    const cache = dollarsPerMillion(pricingText, 'Cached input')
    const rates =
      input !== null && output !== null
        ? {
            input_tokens: input,
            output_tokens: output,
            ...(cache !== null ? { cache_read_tokens: cache } : {}),
          }
        : null
    const contextWindow =
      context !== null && /^[0-9]+$/.test(context) ? Number(context) : null
    models.push({
      rawId,
      displayName: attr(tag, 'data-model-label'),
      activity: task ? (TASK_ACTIVITY[task] ?? null) : null,
      contextWindow,
      pricing: rates ? compileTokenCard(rates, [], source) : null,
    })
  }
  if (models.length === 0) {
    throw new Error('cloudflare-workers-ai: models page listed no ids')
  }
  return models
}

async function listModels(_env: ProviderSecrets): Promise<ListModelsResult> {
  const html = await fetchText(WORKERS_AI_MODELS_URL)
  return {
    models: parseWorkersAiModels(html, {
      url: WORKERS_AI_MODELS_URL,
      hash: await sha256Text(html),
      extractedAt: new Date().toISOString(),
    }),
  }
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
  id: 'cloudflare-workers-ai',
  modelNamespaces: ['workers-ai'],
  displayName: 'Cloudflare Workers AI',
  specSourceUrl: WORKERS_AI_MODELS_URL,
  modelsEndpoint: WORKERS_AI_MODELS_URL,
  defaultDerivation: 'docs-derived',
  fetchSpec,
  listModels,
  classify: () => null,
}
